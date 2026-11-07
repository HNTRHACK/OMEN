// Selfie → avatar, in the browser. Consent first; then a camera capture or a photo; a square crop;
// on-device face landmarks (MediaPipe Face Landmarker, loaded only after consent); a mapping to
// OMEN's stylised face options. The photo never leaves the device, and once mapped every canvas
// holding it is cleared: only the chosen option indices survive.
import { measure, mapFace, mapColours, quality, report, LM } from "./selfie-map.js";

const MP_VERSION = "1.1.1"; // pinned; matches package.json
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let landmarkerP = null;
/** The landmark model, created once (about 4 MB of code and model, from the pinned CDN/model URLs). */
function landmarker() {
  landmarkerP ||= (async () => {
    const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const files = await FilesetResolver.forVisionTasks(WASM_BASE);
    return FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" }, runningMode: "IMAGE", numFaces: 2 });
  })();
  landmarkerP.catch(() => (landmarkerP = null));
  return landmarkerP;
}

/** Decode a photo with its EXIF orientation applied, scaled to at most `max` px. */
export async function photoCanvas(file, max = 1280) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type)) throw new Error("Choose a JPEG, PNG or WebP photo.");
  if (file.size > 15 * 1024 * 1024) throw new Error("That photo is too large (15 MB max).");
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = Object.assign(document.createElement("canvas"), { width: Math.round(bmp.width * s), height: Math.round(bmp.height * s) });
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  if (c.width < 240 || c.height < 240) throw new Error("That photo is too small: use one at least 240 px across.");
  return c;
}

const wipe = (...canvases) => canvases.forEach((c) => c && ((c.width = 0), (c.height = 0)));

function stats(canvas, lm) {
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const W = canvas.width;
  const H = canvas.height;
  const px = (i) => [lm[i].x * W, lm[i].y * H];
  const faceW = Math.hypot(px(LM.cheekL)[0] - px(LM.cheekR)[0], px(LM.cheekL)[1] - px(LM.cheekR)[1]);
  const faceL = Math.hypot(px(LM.top)[0] - px(LM.chin)[0], px(LM.top)[1] - px(LM.chin)[1]);
  const avg = (pts, r) => {
    let n = 0;
    const s = [0, 0, 0];
    for (const [x, y] of pts) {
      const x0 = Math.max(0, Math.round(x - r));
      const y0 = Math.max(0, Math.round(y - r));
      const w = Math.min(W - x0, Math.round(r * 2) || 1);
      const h = Math.min(H - y0, Math.round(r * 2) || 1);
      if (w <= 0 || h <= 0) continue;
      const d = g.getImageData(x0, y0, w, h).data;
      for (let i = 0; i < d.length; i += 4) (s[0] += d[i]), (s[1] += d[i + 1]), (s[2] += d[i + 2]), n++;
    }
    return n ? s.map((v) => v / n) : null;
  };
  const skin = avg([px(LM.cheekSkinL), px(LM.cheekSkinR), px(LM.forehead)], faceW * 0.035);
  const [tx, ty] = px(LM.top);
  const hair = ty - faceL * 0.12 > 0 ? avg([[tx, ty - faceL * 0.12], [tx - faceW * 0.22, ty - faceL * 0.06], [tx + faceW * 0.22, ty - faceL * 0.06]], faceW * 0.04) : null;
  const iris = lm.length > LM.irisR ? avg([px(LM.irisL), px(LM.irisR)], Math.max(1.5, faceW * 0.012)) : null;
  // beside the jaw, just outside the face: hair here means long hair
  const [lx, ly] = px(LM.jawL);
  const [rx, ry] = px(LM.jawR);
  const besideJaw = avg([[lx - faceW * 0.14, ly], [rx + faceW * 0.14, ry]], faceW * 0.04);
  // brightness and sharpness over the face box (Laplacian variance on a small grey copy)
  const x0 = Math.max(0, px(LM.cheekL)[0]);
  const y0 = Math.max(0, ty);
  const bw = Math.max(8, Math.min(W - x0, faceW));
  const bh = Math.max(8, Math.min(H - y0, faceL));
  const small = Object.assign(document.createElement("canvas"), { width: 96, height: 96 });
  const sg = small.getContext("2d", { willReadFrequently: true });
  sg.drawImage(canvas, x0, y0, bw, bh, 0, 0, 96, 96);
  const d = sg.getImageData(0, 0, 96, 96).data;
  const grey = new Float32Array(96 * 96);
  let lum = 0;
  for (let i = 0; i < grey.length; i++) lum += grey[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  let sum = 0;
  let sum2 = 0;
  let k = 0;
  for (let y = 1; y < 95; y++)
    for (let x = 1; x < 95; x++) {
      const i = y * 96 + x;
      const l = 4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - 96] - grey[i + 96];
      sum += l;
      sum2 += l * l;
      k++;
    }
  wipe(small);
  return { colours: { skin, hair, iris, besideJaw }, brightness: lum / grey.length, sharpness: sum2 / k - (sum / k) ** 2, faceW };
}

/** Analyse a (cropped) photo. Returns { face, colours, quality, report } or throws. */
export async function analyse(canvas, { debug = false } = {}) {
  const res = (await landmarker()).detect(canvas);
  const faces = res.faceLandmarks || [];
  if (faces.length !== 1) return { quality: quality({ faces: faces.length }) };
  const lm = faces[0];
  const m = measure(lm, canvas.width, canvas.height);
  const s = stats(canvas, lm);
  const q = quality({ faces: 1, faceW: s.faceW, imageW: canvas.width, yaw: m.yaw, brightness: s.brightness, sharpness: s.sharpness });
  const face = mapFace(m);
  const colours = mapColours(s.colours);
  // `debug` returns the raw proportions for calibration tests only; the app never asks for them
  return { face, colours, quality: q, report: report(face, colours), box: faceBox(lm, canvas), ...(debug ? { measures: m, samples: s.colours } : {}) };
}

/** Find the face for the automatic crop: the whole photo first, then centred crops (small faces). */
async function findFace(photo) {
  const first = await analyse(photo);
  if (first.box || first.quality?.issues?.[0]?.startsWith("More than one")) return first;
  for (const k of [0.7, 0.5]) {
    const size = Math.min(photo.width, photo.height) * k;
    const c = Object.assign(document.createElement("canvas"), { width: 640, height: 640 });
    const x0 = (photo.width - size) / 2;
    const y0 = (photo.height - size) / 2.4; // faces sit a little above the middle
    c.getContext("2d").drawImage(photo, x0, y0, size, size, 0, 0, 640, 640);
    const r = await analyse(c);
    wipe(c);
    if (r.box) return { ...r, box: { cx: x0 + (r.box.cx * size) / 640, cy: y0 + (r.box.cy * size) / 640, size: (r.box.size * size) / 640 } };
  }
  return first;
}

/** Where the face is, for the automatic crop. */
function faceBox(lm, c) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of lm) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
  return { cx: ((x0 + x1) / 2) * c.width, cy: ((y0 + y1) / 2) * c.height, size: Math.max((x1 - x0) * c.width, (y1 - y0) * c.height) };
}

// ---------------------------------------------------------------- the flow (a modal)
export function createSelfie({ onApply, onOpenChange = () => {}, toast }) {
  const root = document.createElement("div");
  root.id = "selfie";
  root.hidden = true;
  root.innerHTML = `<section class="sf-sheet" role="dialog" aria-modal="true" aria-labelledby="sf-h"><div class="sf-body"></div></section>`;
  document.body.append(root);
  const body = root.querySelector(".sf-body");
  root.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
  });
  let stream = null;
  let photo = null; // the full photo canvas (only while the sheet is open)
  let crop = null; // { cx, cy, size } in photo pixels
  let side = null; // optional side-profile canvas
  let mode = "upload";

  const stopCamera = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  };
  function close() {
    stopCamera();
    wipe(photo, side);
    photo = side = crop = null;
    if (root.hidden) return;
    root.hidden = true;
    onOpenChange(false);
  }
  function render(html) {
    body.innerHTML = `<header class="sf-head"><h2 id="sf-h">Avatar from a photo</h2><button class="x" data-close aria-label="Close">×</button></header>${html}`;
    body.querySelector("[data-close]").onclick = close;
    (body.querySelector("[autofocus]") || body.querySelector("button, input"))?.focus({ preventScroll: true });
  }

  // 1. consent
  function open(how = "upload") {
    mode = how;
    if (root.hidden) {
      root.hidden = false;
      onOpenChange(true);
    }
    render(`<p>OMEN can suggest a cartoon likeness from a photo of your face: face shape, jaw, eyes, brows, nose, mouth and colours. You can change everything afterwards.</p>
      <ul class="sf-points">
        <li><b>On this device only.</b> Your photo is analysed in this browser and is never uploaded or stored.</li>
        <li><b>Only the result is kept:</b> the avatar options you pick (like "medium eyes, soft jaw"), not the photo or any face measurements.</li>
        <li><b>Not for identity.</b> It isn't used for World ID, sign-in or any face matching.</li>
        <li>The face-landmark model is downloaded from Google's MediaPipe servers when you continue; no image is sent with it.</li>
      </ul>
      <label class="sf-consent"><input type="checkbox" id="sf-ok"> I agree to analyse my photo on this device to personalise my avatar.</label>
      <div class="row-actions"><button class="btn" id="sf-go" disabled>${how === "camera" ? "Open the camera" : "Choose a photo"}</button><button class="btn ghost" data-close2>Not now</button></div>`);
    body.querySelector("#sf-ok").onchange = (e) => (body.querySelector("#sf-go").disabled = !e.target.checked);
    body.querySelector("[data-close2]").onclick = close;
    body.querySelector("#sf-go").onclick = () => (how === "camera" ? camera() : upload());
  }

  // 2a. camera
  async function camera() {
    render(`<div class="sf-cam"><video id="sf-video" playsinline muted autoplay></video><div class="sf-oval" aria-hidden="true"></div></div>
      <p class="fine" id="sf-cam-msg">Face the camera in even light. Keep your whole face inside the oval.</p>
      <div class="row-actions"><button class="btn" id="sf-snap" disabled>Take photo</button><button class="btn ghost" id="sf-up">Upload instead</button></div>`);
    body.querySelector("#sf-up").onclick = () => (stopCamera(), upload());
    landmarker().catch(() => {}); // start fetching the model while the camera warms up
    try {
      if (!window.isSecureContext) throw Object.assign(new Error("The camera needs a secure (https) page."), { name: "SecurityError" });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
      const v = body.querySelector("#sf-video");
      v.srcObject = stream;
      await v.play();
      body.querySelector("#sf-snap").disabled = false;
      body.querySelector("#sf-snap").onclick = () => {
        const c = Object.assign(document.createElement("canvas"), { width: v.videoWidth, height: v.videoHeight });
        c.getContext("2d").drawImage(v, 0, 0);
        stopCamera();
        photo = c;
        cropStep();
      };
    } catch (e) {
      const why = { NotAllowedError: "Camera permission was declined. You can allow it in the browser's site settings, or upload a photo instead.", NotFoundError: "No camera was found. Upload a photo instead.", NotReadableError: "The camera is busy in another app. Close it, or upload a photo instead.", SecurityError: "The camera only works on a secure (https) page. Upload a photo instead." }[e.name] || `The camera couldn't start (${e.message}). Upload a photo instead.`;
      body.querySelector("#sf-cam-msg").innerHTML = `<span class="err">${esc(why)}</span>`;
    }
  }

  // 2b. upload
  function upload() {
    render(`<label class="sf-drop">Choose a front-facing photo of your face<input type="file" id="sf-file" accept="image/jpeg,image/png,image/webp,image/heic"></label>
      <p class="fine">Best results: one face, looking at the camera, even light, no sunglasses.</p>
      <p id="sf-err" class="err" hidden></p>`);
    landmarker().catch(() => {});
    body.querySelector("#sf-file").onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        photo = await photoCanvas(f);
        cropStep();
      } catch (er) {
        const el = body.querySelector("#sf-err");
        el.hidden = false;
        el.textContent = er.message;
      }
    };
  }

  // 3. crop (auto-centred on the face; drag to move, slider to zoom)
  async function cropStep() {
    render(`<p>Adjust the square so it frames your face.</p><canvas id="sf-crop" width="360" height="360" class="sf-crop" aria-label="Crop preview: drag to move"></canvas>
      <label class="sf-zoom">Zoom <input type="range" id="sf-z" min="0.6" max="2.5" step="0.01" value="1"></label>
      <p id="sf-status" class="fine" aria-live="polite">Finding your face…</p>
      <label class="fine sf-side">Optional: add a side-profile photo to refine the nose <input type="file" id="sf-sidefile" accept="image/jpeg,image/png,image/webp"></label>
      <div class="row-actions"><button class="btn" id="sf-use" disabled>Use this photo</button><button class="btn ghost" id="sf-again">Choose another</button></div>`);
    body.querySelector("#sf-again").onclick = () => (wipe(photo), (photo = null), mode === "camera" ? camera() : upload());
    const view = body.querySelector("#sf-crop");
    const vg = view.getContext("2d");
    const draw = () => {
      vg.fillStyle = "#2b2230";
      vg.fillRect(0, 0, 360, 360);
      vg.drawImage(photo, crop.cx - crop.size / 2, crop.cy - crop.size / 2, crop.size, crop.size, 0, 0, 360, 360);
      vg.strokeStyle = "rgba(251,243,228,.8)";
      vg.lineWidth = 2;
      vg.beginPath();
      vg.ellipse(180, 185, 105, 135, 0, 0, Math.PI * 2);
      vg.stroke();
    };
    const base = Math.min(photo.width, photo.height);
    crop = { cx: photo.width / 2, cy: photo.height / 2, size: base };
    let auto = base;
    try {
      const first = await findFace(photo); // just to place the crop
      if (first.box) {
        auto = Math.min(base, first.box.size * 1.9);
        crop = { cx: first.box.cx, cy: first.box.cy - first.box.size * 0.05, size: auto };
      }
      body.querySelector("#sf-status").textContent = first.box ? "Face found. Adjust if you like, then use the photo." : first.quality.issues.join(" ");
    } catch (er) {
      body.querySelector("#sf-status").innerHTML = `<span class="err">The face model couldn't load (${esc(er.message)}). Check your connection, or create your avatar manually.</span>`;
      draw();
      return;
    }
    const clampCrop = () => {
      crop.size = Math.min(crop.size, base);
      crop.cx = Math.min(Math.max(crop.cx, crop.size / 2), photo.width - crop.size / 2);
      crop.cy = Math.min(Math.max(crop.cy, crop.size / 2), photo.height - crop.size / 2);
    };
    clampCrop();
    draw();
    body.querySelector("#sf-use").disabled = false;
    body.querySelector("#sf-z").oninput = (e) => ((crop.size = auto / Number(e.target.value)), clampCrop(), draw());
    let dragFrom = null;
    view.onpointerdown = (e) => ((dragFrom = { x: e.clientX, y: e.clientY }), view.setPointerCapture(e.pointerId));
    view.onpointermove = (e) => {
      if (!dragFrom) return;
      const k = crop.size / view.getBoundingClientRect().width;
      crop.cx -= (e.clientX - dragFrom.x) * k;
      crop.cy -= (e.clientY - dragFrom.y) * k;
      dragFrom = { x: e.clientX, y: e.clientY };
      clampCrop();
      draw();
    };
    view.onpointerup = () => (dragFrom = null);
    body.querySelector("#sf-sidefile").onchange = async (e) => {
      try {
        side = e.target.files[0] ? await photoCanvas(e.target.files[0], 900) : null;
      } catch (er) {
        toast(er.message, 4000);
      }
    };
    body.querySelector("#sf-use").onclick = async () => {
      const out = Object.assign(document.createElement("canvas"), { width: 640, height: 640 });
      out.getContext("2d").drawImage(photo, crop.cx - crop.size / 2, crop.cy - crop.size / 2, crop.size, crop.size, 0, 0, 640, 640);
      body.querySelector("#sf-use").disabled = true;
      body.querySelector("#sf-status").textContent = "Analysing on this device…";
      try {
        const r = await analyse(out);
        if (side) await refineWithSide(r, side);
        wipe(out, photo, side, view);
        photo = side = null;
        results(r);
      } catch (er) {
        wipe(out);
        body.querySelector("#sf-status").innerHTML = `<span class="err">${esc(er.message)}</span>`;
        body.querySelector("#sf-use").disabled = false;
      }
    };
  }

  /** A side photo can only refine nose length: a clearly turned head shows how far the nose projects. */
  async function refineWithSide(r, canvas) {
    if (!r.face) return;
    const res = (await landmarker()).detect(canvas);
    const lm = res.faceLandmarks?.[0];
    if (!lm) return (r.report.notes = ["The side photo didn't show a face clearly, so it wasn't used."]);
    const m = measure(lm, canvas.width, canvas.height);
    if (Math.abs(m.yaw) < 0.3) return (r.report.notes = ["The side photo wasn't turned enough to help, so it wasn't used."]);
    const depth = (lm[LM.cheekL].z + lm[LM.cheekR].z) / 2 - lm[LM.noseTip].z;
    if (depth > 0.11) r.face.nose = 3; // long / prominent
    r.report.notes = ["Nose length refined from your side photo."];
  }

  // 4. results
  function results(r) {
    if (!r.face) {
      render(`<p class="err">${esc(r.quality.issues.join(" "))}</p><div class="row-actions"><button class="btn" id="sf-retry">Try another photo</button></div>`);
      body.querySelector("#sf-retry").onclick = () => (mode === "camera" ? camera() : upload());
      return;
    }
    render(`<p><b>Your likeness is ready.</b> The photo has been discarded; only these choices remain.</p>
      ${r.quality.issues.length ? `<ul class="sf-warn">${r.quality.issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}
      <p class="fine"><b>Measured from the photo:</b> ${esc(r.report.measured.join(", "))}.</p>
      ${r.report.suggested.length ? `<p class="fine"><b>Colour suggestions:</b> ${esc(r.report.suggested.join("; "))}.</p>` : ""}
      <p class="fine"><b>Not in the photo, so you choose:</b> ${esc(r.report.notDetected.join(", "))}.</p>
      ${r.report.notes ? `<p class="fine">${esc(r.report.notes.join(" "))}</p>` : ""}
      <div class="row-actions"><button class="btn" id="sf-apply" autofocus>Apply to my avatar</button><button class="btn ghost" id="sf-retry">Use a different photo</button></div>`);
    body.querySelector("#sf-retry").onclick = () => (mode === "camera" ? camera() : upload());
    body.querySelector("#sf-apply").onclick = () => {
      onApply({ face: r.face, colours: r.colours, report: r.report });
      close();
    };
  }

  return {
    open,
    close,
    get isOpen() {
      return !root.hidden;
    },
  };
}
