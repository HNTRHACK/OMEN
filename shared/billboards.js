// Advertising hoardings around Blockhaven (map coordinates, like layout.js), and ad terms.
export const BOARDS = [
  { id: "board-plaza", label: "Plaza hoarding", at: [-1.8, 7.4], face: [0, 0] },
  { id: "board-market", label: "Market hoarding", at: [9.6, -1.6], face: [3, 0] },
  { id: "board-garden", label: "Garden hoarding", at: [-9.8, -3.4], face: [-4, -1] },
  { id: "board-lookout", label: "Lookout hoarding", at: [13.6, 12.8], face: [9.5, 7.5] },
];
export const boardById = (id) => BOARDS.find((b) => b.id === id) || null;

/** 1 day is free (after moderation); longer runs are rented at this rate. */
export const AD_DAYS = [1, 3, 7];
export const AD_RENT_PAISE_PER_DAY = 2000; // ₹20/day
