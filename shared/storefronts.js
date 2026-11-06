// Storefront plots players can claim, and the NPC-run shops. Map coordinates (x east, z south),
// like layout.js. Two plots reuse the plaza's market stalls; two get new stalls.
export const PLOTS = [
  { id: "plot-west", label: "West stall", at: [-6.9, 3.6], face: [-4.8, 2.2], existing: true },
  { id: "plot-east", label: "East stall", at: [5.0, 4.8], face: [3.6, 3.0], existing: true },
  { id: "plot-garden", label: "Garden stall", at: [-7.6, -1.4], face: [-3.2, -0.6], existing: false },
  { id: "plot-lantern", label: "Lantern stall", at: [7.4, 1.2], face: [3.0, 0.4], existing: false },
];
export const plotById = (id) => PLOTS.find((p) => p.id === id) || null;

/** Awning / sign colours a shop owner can choose. */
export const SHOP_COLORS = [0xb85c4a, 0x3e8e8a, 0x5f7d99, 0x5e9a5b, 0x7d5a8c, 0xc99a3c];
