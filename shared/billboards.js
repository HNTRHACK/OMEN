// Advertising hoardings around Blockhaven (map coordinates, like layout.js), and ad terms.
// Spots chosen by raycasting the live scene for a clear view from where a player and their camera
// stand: no trees, houses or the relay in front of the face. Each hoarding has its own look
// (`style`, built in src/community.js) so they read as different places, not copies.
export const BOARDS = [
  { id: "board-plaza", label: "Plaza hoarding", at: [7.8, -3.5], face: [3.9, -1.7], style: "classic" },
  { id: "board-well", label: "Well hoarding", at: [-2.6, -8.1], face: [-1.3, -4.0], style: "gantry" },
  { id: "board-garden", label: "Garden hoarding", at: [-12.7, -2.7], face: [-6.4, -1.4], style: "bunting" },
  { id: "board-lookout", label: "Lookout hoarding", at: [13.6, 12.8], face: [9.5, 7.5], style: "stone" },
];
export const boardById = (id) => BOARDS.find((b) => b.id === id) || null;

/** How many ads can hold one hoarding at the same time (they rotate every few seconds). */
export const SLOTS_PER_BOARD = 2;

/** 1 day is free (after moderation); longer runs are DEMO-priced rentals at this rate. */
export const AD_DAYS = [1, 3, 7];
export const AD_RENT_PAISE_PER_DAY = 2000; // ₹20/day in DEMO credits (or testnet USDT); no real money

export const AD_STATUS_LABEL = {
  pending: "Waiting for moderator review",
  awaiting_rent: "Approved: confirm the DEMO rental to go live",
  live: "LIVE",
  rejected: "Not approved",
  expired: "Ended (ran its full time)",
  removed: "Taken down by a moderator",
};
