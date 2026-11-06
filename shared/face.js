// A courier's face: small integers into fixed option lists, exactly like look.js, so it is tiny to
// sync and trivial to validate. It holds only the chosen stylised options, never a photo, landmarks
// or measurements.
//
// STATUS: used by the browser today. The server (shared/look.js cleanLook, /api/avatar) does not
// accept it yet: see docs/contracts/avatar-face-frontend-requirements.md for what the backend must
// add so other players and the saved World ID avatar include the face.

export const FACE_OPTIONS = {
  headWidth: [{ name: "Narrow", v: 0.88 }, { name: "Slim", v: 0.94 }, { name: "Medium", v: 1 }, { name: "Broad", v: 1.06 }, { name: "Wide", v: 1.12 }],
  headLength: [{ name: "Short", v: 0.9 }, { name: "Compact", v: 0.95 }, { name: "Medium", v: 1 }, { name: "Long", v: 1.06 }, { name: "Tall", v: 1.12 }],
  jaw: [{ name: "Round", x: 1.0, chin: 0 }, { name: "Soft", x: 0.93, chin: 0.01 }, { name: "Square", x: 1.07, chin: -0.005 }, { name: "Tapered", x: 0.84, chin: 0.03 }, { name: "Pointed chin", x: 0.78, chin: 0.05 }],
  eyeSize: [{ name: "Small", v: 0.72 }, { name: "Neat", v: 0.86 }, { name: "Medium", v: 1 }, { name: "Large", v: 1.16 }, { name: "Big", v: 1.32 }],
  eyeSpacing: [{ name: "Close", v: -0.022 }, { name: "Near", v: -0.011 }, { name: "Medium", v: 0 }, { name: "Apart", v: 0.011 }, { name: "Wide", v: 0.022 }],
  eyeColor: [
    { name: "Dark brown", hex: 0x2b2230 },
    { name: "Brown", hex: 0x5a3a24 },
    { name: "Hazel", hex: 0x7a6334 },
    { name: "Green", hex: 0x3f6b4a },
    { name: "Blue", hex: 0x3f6a9a },
    { name: "Grey", hex: 0x6c7480 },
  ],
  brows: [{ name: "None" }, { name: "Straight" }, { name: "Soft arch" }, { name: "High arch" }, { name: "Angled" }, { name: "Thick" }],
  nose: [{ name: "Small", s: [0.7, 0.75, 0.75] }, { name: "Button", s: [0.9, 0.85, 1.05] }, { name: "Medium", s: [1, 1, 1] }, { name: "Long", s: [0.95, 1.45, 1.15] }, { name: "Wide", s: [1.45, 1.05, 1.0] }],
  mouth: [{ name: "None" }, { name: "Small smile" }, { name: "Smile" }, { name: "Wide smile" }, { name: "Neutral" }, { name: "Full lips" }],
  ears: [{ name: "Hidden" }, { name: "Small" }, { name: "Medium" }, { name: "Large" }],
  facialHair: [{ name: "None" }, { name: "Stubble" }, { name: "Moustache" }, { name: "Short beard" }, { name: "Full beard" }],
  glasses: [{ name: "None" }, { name: "Round" }, { name: "Rectangle" }, { name: "Cat-eye" }, { name: "Sunglasses" }],
  hairStyle: [{ name: "Classic" }, { name: "Buzz" }, { name: "Curly top" }, { name: "Side part" }, { name: "Ponytail" }, { name: "Big curls" }, { name: "Long straight" }],
};

export const FACE_KEYS = Object.keys(FACE_OPTIONS);
/** The default face reproduces the original courier exactly (no new parts, no deformation). */
export const DEFAULT_FACE = Object.freeze({ headWidth: 2, headLength: 2, jaw: 0, eyeSize: 2, eyeSpacing: 2, eyeColor: 0, brows: 0, nose: 2, mouth: 0, ears: 0, facialHair: 0, glasses: 0, hairStyle: 0 });

/** Validate an untrusted face: every key an in-range integer, nothing extra. Null if absent. */
export function cleanFace(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const k of FACE_KEYS) {
    const v = Math.trunc(Number(raw[k]));
    out[k] = Number.isFinite(v) && v >= 0 && v < FACE_OPTIONS[k].length ? v : DEFAULT_FACE[k];
  }
  return out;
}
