// QR codes: drawing them (merchant signs in the village) and reading them (camera, image file,
// or the pixels of an in-world sign: the game decodes what's painted, it doesn't peek at a string).
import qrcode from "qrcode-generator";
import jsQR from "jsqr";

/** Draw `text` as a QR on a new canvas, ink on paper, with a quiet zone. */
export function qrCanvas(text, px = 256) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const quiet = 4;
  const cell = Math.max(1, Math.floor(px / (n + quiet * 2)));
  const size = cell * (n + quiet * 2);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.fillStyle = "#fbf3e4";
  g.fillRect(0, 0, size, size);
  g.fillStyle = "#2b2230";
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) g.fillRect((k + quiet) * cell, (r + quiet) * cell, cell, cell);
  return c;
}

/** Decode a QR from a canvas / ImageData. Returns the text or null. */
export function decodeCanvas(c) {
  const img = c instanceof ImageData ? c : c.getContext("2d").getImageData(0, 0, c.width, c.height);
  return jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

export async function decodeFile(file) {
  if (!/^image\//.test(file.type)) throw new Error("Choose an image of a QR code.");
  if (file.size > 8 * 1024 * 1024) throw new Error("That image is too large (8 MB max).");
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const text = decodeCanvas(c);
  if (!text) throw new Error("Couldn't find a QR code in that image.");
  return text;
}

/**
 * Scan with the camera into `video`. Resolves with the first QR text; call the returned
 * `stop()` to cancel. Uses BarcodeDetector where available, else jsQR on video frames.
 */
export function scanCamera(video) {
  let stream;
  let stopped = false;
  let raf = 0;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  const result = (async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't use the camera here. Upload a photo or paste the code instead.");
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    if (stopped) return stop(), null;
    video.srcObject = stream;
    await video.play();
    const det = "BarcodeDetector" in window ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
    const c = document.createElement("canvas");
    const g = c.getContext("2d", { willReadFrequently: true });
    return new Promise((resolve, reject) => {
      const tick = async () => {
        if (stopped) return resolve(null);
        try {
          let text = null;
          if (video.readyState >= 2) {
            if (det) text = (await det.detect(video))[0]?.rawValue ?? null;
            else {
              c.width = video.videoWidth;
              c.height = video.videoHeight;
              g.drawImage(video, 0, 0);
              text = decodeCanvas(c);
            }
          }
          if (text) {
            stop();
            return resolve(text);
          }
        } catch (e) {
          stop();
          return reject(e);
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    });
  })();
  return { result, stop };
}
