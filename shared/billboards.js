// Advertising hoardings around Blockhaven (map coordinates, like layout.js), and ad terms.
// Spots chosen by raycasting the live scene for a clear view from where a player and their camera
// stand (see e2e notes in README): no trees, houses or the relay in front of the face.
export const BOARDS = [
  { id: "board-plaza", label: "Plaza hoarding", at: [7.8, -3.5], face: [3.9, -1.7] },
  { id: "board-well", label: "Well hoarding", at: [-2.6, -8.1], face: [-1.3, -4.0] },
  { id: "board-garden", label: "Garden hoarding", at: [-12.7, -2.7], face: [-6.4, -1.4] },
  { id: "board-lookout", label: "Lookout hoarding", at: [13.6, 12.8], face: [9.5, 7.5] },
];
export const boardById = (id) => BOARDS.find((b) => b.id === id) || null;

/** 1 day is free (after moderation); longer runs are rented at this rate. */
export const AD_DAYS = [1, 3, 7];
export const AD_RENT_PAISE_PER_DAY = 2000; // ₹20/day
