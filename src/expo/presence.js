// Shared arrival positions for server-assigned room slots. Keep the first arrival
// at the venue's original spawn, with later people beside it on unobstructed floor.
import { SPAWN, collide, groundAt, BOUNDS, decodePos } from './layout.js';

export function arrivalForSlot(slot = 0) {
  const n = Number.isInteger(slot) && slot >= 0 && slot < 16 ? slot : 0;
  const columns = [0, -2.4, 2.4, -4.8, 4.8];
  return { x: SPAWN.x + columns[n % columns.length], z: SPAWN.z - Math.floor(n / columns.length) * 2.4, yaw: SPAWN.yaw };
}

// The persisted snapshot can restore a refresh on the stage as well as the floor.
// Reject other-world/malformed coordinates rather than placing a player off-scene.
export function resumePosition(state) {
  const d = state?.d;
  if (!Array.isArray(d) || d.length !== 3 || !d.every(Number.isFinite) || d[1] < 0.9) return null;
  const { x, z } = decodePos(d);
  if (x < BOUNDS.x0 + 0.5 || x > BOUNDS.x1 - 0.5 || z < BOUNDS.z0 + 0.5 || z > BOUNDS.z1 - 0.5) return null;
  const p = collide(x, z, 0.42);
  return { ...p, y: Math.max(groundAt(p.x, p.z), Number.isFinite(state.h) ? state.h : 0) };
}
