// Selfie → stylised avatar options. Pure functions (no DOM), so they're unit-tested.
//
// Input: MediaPipe Face Landmarker landmarks (478 points, normalised x/y/z) for ONE face, plus the
// image size and a few sampled colours. Output: indices into shared/face.js and shared/look.js,
// and a plain-language report of what was measured, what is only a colour suggestion, and what the
// photo can't tell us. Only visible geometry and colours are used: nothing about who the person
// is (no age, gender, ethnicity or identity), and nothing is kept after mapping.
import { FACE_OPTIONS, DEFAULT_FACE } from "../shared/face.js";
import { LOOK_OPTIONS } from "../shared/look.js";

// Landmark indices (MediaPipe canonical face mesh).
export const LM = {
  top: 10, chin: 152, cheekL: 234, cheekR: 454, jawL: 172, jawR: 397, chinL: 149, chinR: 378,
  eyeLo: 33, eyeLi: 133, eyeRi: 362, eyeRo: 263, eyeLt: 159, eyeLb: 145, eyeRt: 386, eyeRb: 374,
  browL: [70, 63, 105, 66, 107], browR: [336, 296, 334, 293, 300],
  noseTop: 168, noseTip: 1, noseBottom: 2, alarL: 98, alarR: 327,
  mouthL: 61, mouthR: 291, lipTop: 0, lipTopIn: 13, lipBotIn: 14, lipBot: 17,
  irisL: 468, irisR: 473, cheekSkinL: 205, cheekSkinR: 425, forehead: 151,
};

/** Bucket a value: thresholds ascending → index 0..thresholds.length. */
export const bucket = (v, th) => th.findIndex((t) => v < t) === -1 ? th.length : th.findIndex((t) => v < t);
const clampI = (i, n) => Math.max(0, Math.min(n - 1, i));

/** Measure proportions from landmarks. `w`/`h` turn normalised coordinates into pixels. */
export function measure(lm, w, h) {
  const p = (i) => ({ x: lm[i].x * w, y: lm[i].y * h, z: lm[i].z * w });
  const d = (a, b) => Math.hypot(p(a).x - p(b).x, p(a).y - p(b).y);
  const faceW = d(LM.cheekL, LM.cheekR);
  const faceL = d(LM.top, LM.chin);
  const eyeW = (d(LM.eyeLo, LM.eyeLi) + d(LM.eyeRi, LM.eyeRo)) / 2;
  const eyeH = (d(LM.eyeLt, LM.eyeLb) + d(LM.eyeRt, LM.eyeRb)) / 2;
  // brow arch: how far the middle of the brow rises above the line between its ends
  const arch = (ids) => {
    const a = p(ids[0]);
    const b = p(ids[ids.length - 1]);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let peak = 0;
    for (const i of ids.slice(1, -1)) {
      const q = p(i);
      // distance above the a→b line (image y grows downward)
      const cross = ((b.x - a.x) * (a.y - q.y) - (b.y - a.y) * (a.x - q.x)) / len;
      peak = Math.max(peak, Math.abs(cross));
    }
    return { arch: peak / len, slope: Math.abs(b.y - a.y) / len };
  };
  const bl = arch(LM.browL);
  const br = arch(LM.browR);
  const midLip = (p(LM.lipTopIn).y + p(LM.lipBotIn).y) / 2;
  const corners = (p(LM.mouthL).y + p(LM.mouthR).y) / 2;
  // head turn: nose tip should sit midway between the cheeks for a frontal photo
  const nose = p(LM.noseTip);
  const yaw = ((nose.x - p(LM.cheekL).x) - (p(LM.cheekR).x - nose.x)) / faceW;
  return {
    faceW,
    faceL,
    lengthRatio: faceL / faceW,
    jawRatio: d(LM.jawL, LM.jawR) / faceW,
    chinRatio: d(LM.chinL, LM.chinR) / faceW,
    eyeWidth: eyeW / faceW,
    eyeOpen: eyeH / eyeW,
    eyeGap: d(LM.eyeLi, LM.eyeRi) / faceW,
    browArch: (bl.arch + br.arch) / 2,
    browSlope: (bl.slope + br.slope) / 2,
    noseWidth: d(LM.alarL, LM.alarR) / faceW,
    noseLength: d(LM.noseTop, LM.noseBottom) / faceL,
    mouthWidth: d(LM.mouthL, LM.mouthR) / faceW,
    lipFullness: (d(LM.lipTop, LM.lipTopIn) + d(LM.lipBotIn, LM.lipBot)) / faceL,
    smile: (midLip - corners) / faceL, // > 0: corners higher than the middle
    yaw,
  };
}

/** Map measured proportions to face option indices (the stylised likeness). */
export function mapFace(m) {
  const n = (k) => FACE_OPTIONS[k].length;
  // Ranges calibrated on MediaPipe output for frontal portraits (typical values in brackets).
  const headLength = clampI(bucket(m.lengthRatio, [1.18, 1.25, 1.32, 1.39]), n("headLength")); // [1.27–1.30]
  const headWidth = clampI(2 + Math.round((2 - headLength) / 2), n("headWidth"));
  let jaw;
  if (m.jawRatio > 0.87) jaw = 2; // square [jaw 0.81–0.84]
  else if (m.jawRatio < 0.75 && m.chinRatio < 0.4) jaw = 4; // pointed chin
  else if (m.jawRatio < 0.78) jaw = 3; // tapered
  else jaw = m.chinRatio > 0.45 ? 0 : 1; // round / soft [chin 0.43–0.47]
  const eyeSize = clampI(bucket(m.eyeWidth, [0.17, 0.188, 0.208, 0.226]), n("eyeSize"));
  const eyeSpacing = clampI(bucket(m.eyeGap, [0.215, 0.235, 0.265, 0.285]), n("eyeSpacing"));
  const brows = m.browSlope > 0.2 ? 4 : m.browArch > 0.165 ? 3 : m.browArch > 0.1 ? 2 : 1; // [arch 0.13–0.15]
  let nose;
  if (m.noseWidth > 0.3) nose = 4; // wide
  else if (m.noseLength > 0.34) nose = 3; // long
  else if (m.noseWidth < 0.235 && m.noseLength < 0.27) nose = 0; // small
  else if (m.noseLength < 0.285) nose = 1; // button
  else nose = 2;
  let mouth;
  if (m.lipFullness > 0.1) mouth = 5; // full lips
  else if (m.smile < -0.004) mouth = 4; // neutral
  else mouth = 1 + clampI(bucket(m.mouthWidth, [0.42, 0.5]), 3); // small smile / smile / wide smile [0.48–0.51]
  return { ...DEFAULT_FACE, headWidth, headLength, jaw, eyeSize, eyeSpacing, brows, nose, mouth, ears: 2 };
}

// ---------------------------------------------------------------- colours
const lin = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
/** sRGB [r,g,b] 0–255 → CIE Lab (D65), for perceptual nearest-colour matching. */
export function lab([r, g, b]) {
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Index of the swatch closest to `color` (perceptually), and that distance. */
export function nearest(color, swatches) {
  const c = lab(color);
  let best = 0;
  let bd = Infinity;
  swatches.forEach((s, i) => {
    const dd = dist(c, lab(rgb(s.hex)));
    if (dd < bd) (bd = dd), (best = i);
  });
  return { index: best, distance: bd };
}

/**
 * Colour suggestions. `samples` = { skin, hair, iris } as [r,g,b] or null. Hair is only suggested
 * when the sampled area clearly isn't skin (a forehead or bald crown would read as skin).
 */
export function mapColours(samples) {
  const out = {};
  if (samples.skin) out.skin = nearest(samples.skin, LOOK_OPTIONS.skin).index;
  if (samples.hair && (!samples.skin || dist(lab(samples.hair), lab(samples.skin)) > 18)) out.hair = nearest(samples.hair, LOOK_OPTIONS.hair).index;
  if (samples.iris) out.eyeColor = nearest(samples.iris, FACE_OPTIONS.eyeColor).index;
  // long hair: the colour beside the jaw matches the hair (and isn't skin)
  // (hair in shadow is darker than at the crown, so "closer to hair than to skin, and not far off")
  if (out.hair !== undefined && samples.besideJaw && samples.skin) {
    const toHair = dist(lab(samples.besideJaw), lab(samples.hair));
    const toSkin = dist(lab(samples.besideJaw), lab(samples.skin));
    if (toHair < 45 && toHair < toSkin * 0.7) out.longHair = true;
  }
  return out;
}

/** Photo quality: problems that make the mapping unreliable, in plain language. */
export function quality({ faces, faceW, imageW, yaw, brightness, sharpness }) {
  const issues = [];
  if (faces === 0) return { ok: false, issues: ["No face found. Use a clear, front-facing photo of one face."] };
  if (faces > 1) return { ok: false, issues: ["More than one face is in the photo. Crop it to just you."] };
  if (faceW / imageW < 0.22) issues.push("Your face is small in the photo: crop closer for a better match.");
  if (Math.abs(yaw) > 0.26) issues.push("Your head is turned: face the camera for accurate proportions.");
  if (brightness < 60) issues.push("The photo is dark: colours (skin, hair, eyes) may be off.");
  if (brightness > 215) issues.push("The photo is very bright: colours may be washed out.");
  if (sharpness < 40) issues.push("The photo looks blurry: features may be less accurate.");
  return { ok: true, issues };
}

/** The report shown to the player: honest about what a single photo can and can't support. */
export function report(face, colours) {
  return {
    measured: ["face length and width", "jaw and chin shape", "eye size and spacing", "eyebrow shape", "nose proportions", "mouth width and lips"],
    suggested: Object.keys(colours).map((k) => ({ skin: "skin tone (from your cheeks; lighting changes it)", hair: "hair colour", eyeColor: "eye colour (low confidence)", longHair: "long hair" })[k]),
    notDetected: ["ears (not visible to the landmark model)", colours.longHair ? "hairstyle details" : "hairstyle", "facial hair", "glasses", ...(colours.hair === undefined ? ["hair colour"] : [])],
  };
}
