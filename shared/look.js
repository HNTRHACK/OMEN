// A courier's appearance: small integers into fixed option lists, so it's tiny to sync and trivial
// to validate (the server never accepts anything but these indices).

export const LOOK_OPTIONS = {
  skin: [
    { name: "Warm sand", hex: 0xe3b08c },
    { name: "Honey", hex: 0xc98c5e },
    { name: "Chestnut", hex: 0x9a6440 },
    { name: "Deep brown", hex: 0x6b432c },
    { name: "Porcelain", hex: 0xf2cfb4 },
  ],
  hair: [
    { name: "Ink", hex: 0x3a2a2a },
    { name: "Chestnut", hex: 0x7a4a2a },
    { name: "Auburn", hex: 0xa8492e },
    { name: "Wheat", hex: 0xd9b46a },
    { name: "Silver", hex: 0xc9c4cc },
    { name: "Teal", hex: 0x3e8e8a },
  ],
  hairStyle: [{ name: "Short" }, { name: "Long" }, { name: "Bun" }],
  hat: [{ name: "Courier cap" }, { name: "No hat" }, { name: "Beanie" }, { name: "Straw hat" }, { name: "Top hat" }],
  hatColor: [
    { name: "Brick red", hex: 0xc8473d },
    { name: "Butter", hex: 0xf3d98b },
    { name: "Slate", hex: 0x5f7d99 },
    { name: "Leaf", hex: 0x5e9a5b },
    { name: "Ink", hex: 0x2b2230 },
  ],
  jacket: [
    { name: "Courier teal", hex: 0x3e8e8a },
    { name: "Brick", hex: 0xb85c4a },
    { name: "Slate", hex: 0x5f7d99 },
    { name: "Leaf", hex: 0x5e9a5b },
    { name: "Plum", hex: 0x7d5a8c },
    { name: "Mustard", hex: 0xc99a3c },
  ],
  pants: [
    { name: "Navy", hex: 0x2f3e5c },
    { name: "Ink", hex: 0x2b2230 },
    { name: "Olive", hex: 0x6b6a3c },
    { name: "Stone", hex: 0x9e9384 },
  ],
  scarf: [
    { name: "Butter", hex: 0xf3d98b },
    { name: "Petal", hex: 0xe88aa6 },
    { name: "Sky", hex: 0x9fc9d4 },
    { name: "Cream", hex: 0xf1e6d2 },
  ],
  body: [
    { name: "Regular", sx: 1, sy: 1 },
    { name: "Slim", sx: 0.88, sy: 1.03 },
    { name: "Sturdy", sx: 1.14, sy: 0.98 },
    { name: "Small", sx: 0.95, sy: 0.9 },
  ],
  accessory: [{ name: "None" }, { name: "Round glasses" }, { name: "Headphones" }, { name: "Flower" }],
  pet: [{ name: "No pet" }, { name: "Cat" }, { name: "Dog" }, { name: "Bird" }],
};

export const LOOK_KEYS = Object.keys(LOOK_OPTIONS);
export const DEFAULT_LOOK = Object.freeze(Object.fromEntries(LOOK_KEYS.map((k) => [k, 0])));

/** Validate an untrusted look: every key an in-range integer, nothing extra. */
export function cleanLook(raw) {
  const out = {};
  for (const k of LOOK_KEYS) {
    const v = Math.trunc(Number(raw?.[k]));
    out[k] = Number.isFinite(v) && v >= 0 && v < LOOK_OPTIONS[k].length ? v : 0;
  }
  return out;
}

/** Old clients sent a single outfit index (jacket colour). */
export const lookFromOutfit = (outfit) => cleanLook({ ...DEFAULT_LOOK, jacket: outfit });

export function randomLook(rand = Math.random) {
  const l = {};
  for (const k of LOOK_KEYS) l[k] = Math.floor(rand() * LOOK_OPTIONS[k].length);
  l.hat = rand() < 0.4 ? 0 : l.hat;
  l.pet = rand() < 0.5 ? 0 : l.pet;
  return l;
}
