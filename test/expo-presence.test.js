import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrivalForSlot, resumePosition } from '../src/expo/presence.js';
import { SPAWN, collide, encodePos, STAGE } from '../src/expo/layout.js';
import { cleanState } from '../server/realtime.js';

test('all sixteen lobby slots are separate and on clear arrival floor', () => {
  const arrivals = Array.from({ length: 16 }, (_, i) => arrivalForSlot(i));
  assert.deepEqual(arrivals[0], SPAWN);
  for (const [i, p] of arrivals.entries()) {
    assert.deepEqual(collide(p.x, p.z, 0.42), { x: p.x, z: p.z }, `slot ${i} must not collide with venue geometry`);
    for (const other of arrivals.slice(0, i)) assert.ok(Math.hypot(p.x - other.x, p.z - other.z) >= 2.39);
  }
});

test('refresh restores valid server snapshots on the floor and stage; other-world and malformed positions are rejected', () => {
  const state = (x, z, h = 0) => cleanState({ d: encodePos(x, z), f: [0, 0, -1], h });
  const floor = resumePosition(state(SPAWN.x + 2.4, SPAWN.z));
  assert.ok(Math.abs(floor.x - (SPAWN.x + 2.4)) < 0.01);
  assert.ok(Math.abs(floor.z - SPAWN.z) < 0.01);
  assert.equal(floor.y, 0);
  const stage = resumePosition(state(STAGE.x0 + 2, STAGE.z0 + 2));
  assert.equal(stage.y, STAGE.h, 'never restore an avatar underneath the stage');
  for (const s of [null, {}, { d: [0, 0, 1] }, { d: [NaN, 1, 0] }, state(10000, 10000)]) assert.equal(resumePosition(s), null);
});
