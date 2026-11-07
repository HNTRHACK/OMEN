import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { io } from 'socket.io-client';
import { attachRealtime } from '../server/realtime.js';
import { encodePos } from '../src/expo/layout.js';

async function harness(t) {
  const server = createServer(), rt = attachRealtime(server);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => rt.io.close(r)));
  return { rt, async join(token = randomBytes(32).toString('hex'), extra = {}) {
    const socket = io(`http://127.0.0.1:${server.address().port}/world`, { transports: ['websocket'], forceNew: true });
    t.after(() => socket.close());
    const reply = await new Promise(resolve => socket.emit('join', { room: 'omen-expo', name: 'Guest', token, ...extra }, resolve));
    return { socket, reply, token };
  } };
}

test('simultaneous Expo guests get unique arrival slots, initial snapshots and distinct identities', async t => {
  const h = await harness(t);
  const peers = await Promise.all(Array.from({ length: 4 }, (_, i) => h.join(undefined, { name: 'Guest ' + i, state: { d: encodePos(-3, 13), f: [0, 0, -1], h: 0 } })));
  assert.equal(new Set(peers.map(p => p.reply.id)).size, 4);
  assert.equal(new Set(peers.map(p => p.reply.spawnSlot)).size, 4);
  assert.ok(peers.every(p => p.reply.room === 'omen-expo' && p.reply.state?.d && p.reply.resumed === false));
  const late = await h.join();
  assert.equal(late.reply.online, 5);
  assert.equal(late.reply.players.length, 4);
  assert.ok(late.reply.players.every(p => Array.isArray(p.s.d)));
});

test('presence excludes reconnect ghosts while resuming the same guest preserves its slot and snapshot', async t => {
  const h = await harness(t), a = await h.join(), b = await h.join();
  const notice = new Promise(resolve => a.socket.on('presence', p => p.online === 1 && resolve(p)));
  b.socket.close();
  assert.equal((await notice).online, 1);
  const resumed = await h.join(b.token);
  assert.equal(resumed.reply.id, b.reply.id);
  assert.equal(resumed.reply.spawnSlot, b.reply.spawnSlot);
  assert.equal(resumed.reply.resumed, true);
  assert.equal(resumed.reply.online, 2);
  assert.equal(resumed.reply.players.length, 1);
});
