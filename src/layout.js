// Blockhaven, laid out in metres on a map centred on the planet's north pole.
// x → east, z → south. Buildings face the lane in front of them.

export const SPOTS = {
  plaza: [0, 0],
  relay: [0, 0],
  post: { at: [-15.5, 10.5], face: [-9, 5] },
  chai: { at: [15.5, -10], face: [8, -4] },
  workshop: { at: [-7, -19.5], face: [-4.2, -12] },
  lookout: [19.5, 14.5],
  spawn: { at: [-9.6, 5.7], face: [-15.5, 10.5] }, // just outside the post office, looking back at it
};

// Lanes (map points; smoothed into curves at build time)
export const LANES = [
  [[-12.8, 7.6], [-9.5, 6.4], [-6.5, 4.2], [-3.5, 1.8], [0, 0]], // post office → plaza
  [[0, 0], [3.5, -1.6], [6.5, -3.0], [9.3, -5.4], [11.4, -6.6]], // plaza → Maya
  [[0, 0], [-1.2, -4.5], [-3.8, -8.0], [-3.0, -11.4], [-4.4, -14.4]], // plaza → Orin (winding)
  [[0, 0], [3.8, 3.6], [8.6, 6.2], [12.8, 8.9], [16.6, 11.8]], // plaza → lookout
  [[9.3, -5.4], [8.4, -10.4], [4.4, -13.8], [-0.6, -14.4], [-3.0, -11.4]], // Maya ↔ Orin back lane
  [[-9.5, 6.4], [-12.6, 1.6], [-11.8, -5.4], [-8.4, -10.6], [-3.8, -8.0]], // post office ↔ Orin, past the gardens
];

// Paved areas: [x, z, radius]
export const AREAS = [
  [0, 0, 6.2], // plaza
  [-12.2, 7.4, 3.2], // post office forecourt
  [11.8, -7.2, 3.4], // tea stall terrace
  [-5, -15.2, 3.4], // workshop yard
  [17, 12.2, 2.6], // lookout
];

// Hand-placed props: [model, x, z, faceX, faceZ, scale?]
export const PROPS = [
  ["well", -4.2, -4.0, 0, 0],
  ["noticeboard", 3.4, 4.3, 0, 0],
  ["bench", -3.6, 3.1, 0, 0],
  ["bench", 4.6, -0.6, 0, 0],
  ["bench", 1.4, 5.0, 0, 0],
  ["signpost", 2.4, -3.4, 0, 0],
  ["market_stall", -6.9, 3.6, -4.8, 2.2],
  ["market_stall", 5.0, 4.8, 3.6, 3.0],
  ["planter", 2.4, -6.2, 0, 0],
  ["planter", 5.2, 1.8, 0, 0],
  ["crates", 18.6, -8.4, 12, -6],
  ["crates", -9.8, -17.4, -4, -13],
  ["bench", 17.6, 14.6, 12, 9],
  ["rocks", 21.2, 13.2, 0, 0, 1.4],
  ["rocks", 20.0, 16.8, 0, 0, 1.1],
  ["string_pole", 10.6, -12.6, 15.5, -10],
  ["planter", -17.6, 6.8, -9, 5],
  ["crates", -18.6, 9.2, -9, 5],
];

// Building and relay footprints for collision: [x, z, radius]
export const SOLIDS = [
  [-15.5, 10.5, 4.3],
  [15.5, -10, 3.7],
  [-7, -19.5, 3.4],
  [0, 0, 1.0],
];
