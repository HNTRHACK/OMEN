import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { io } from 'socket.io-client';

const base = process.argv[2];
const expectedCommit = process.argv[3];
if (!base?.startsWith('https://')) throw new Error('Pass the actual deployed HTTPS origin.');
const request = async (path, body) => {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  return { status: response.status, data: await response.json() };
};
for (const path of ['/', '/expo.html', '/royale-admin.html', '/moderate.html']) {
  const response = await fetch(base + path); assert.equal(response.status, 200, path);
  const html = await response.text();
  if (path === '/') assert.match(html, /ENTER BOUNTY ROYALE/);
  for (const match of html.matchAll(/(?:src|href)="(\.\/assets\/[^" ]+)"/g)) {
    assert.equal((await fetch(new URL(match[1], base + path))).status, 200, match[1]);
  }
}
assert.deepEqual((await request('/api/health')).data, { ok: true });
const deployment = (await request('/api/deployment')).data;
assert.equal(deployment.branch, 'final-block');
if (expectedCommit) assert.equal(deployment.commit, expectedCommit);
const world = (await request('/api/world/config')).data;
assert.equal(world.configured, true); assert.equal(world.environment, 'production'); assert.equal(world.allowGuest, false);
const context = await request('/api/world/rp-context', {});
assert.equal(context.status, 200); assert.match(context.data.rp_context.signature, /^0x[0-9a-f]{130}$/i);
assert.equal((await request('/api/royale/join', {})).status, 401);
assert.equal((await request('/api/royale/predictions', { marketId: 'game-wildcard', selection: 'yes', amount: 1, idempotencyKey: 'unauthorized-check' })).status, 401);
assert.equal((await request('/api/royale/mod/me')).status, 401);
const arena = await request('/api/royale/state');
assert.equal(arena.status, 200); assert.ok(arena.data.markets.length >= 15);
assert.match(arena.data.label, /Non-transferable, non-redeemable/);
console.log(JSON.stringify({ http: 'passed', deployment, worldId: 'production configuration and request signing passed; real proof not tested', markets: arena.data.markets.length, projects: arena.data.projects.length, demoMode: arena.data.demoMode, authorization: 'unverified points writes and moderator access rejected' }));

const sockets = [];
function next(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, listener); reject(new Error('Timed out waiting for ' + name)); }, 15000);
    const listener = value => { clearTimeout(timer); resolve(value); };
    socket.once(name, listener);
  });
}
async function connect(namespace, path) {
  const socket = io(base + namespace, { path, transports: ['websocket'], forceNew: true, reconnection: false, timeout: 15000 });
  sockets.push(socket);
  await Promise.race([next(socket, 'connect'), next(socket, 'connect_error').then(error => { throw error; })]);
  return socket;
}
try {
  const a = await connect('/world', '/socket.io/'), b = await connect('/world', '/socket.io/');
  const room = 'deploy-' + randomBytes(4).toString('hex');
  const join = socket => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('World join timed out')), 15000);
    socket.emit('join', { room, name: 'Deployment check', token: randomBytes(32).toString('hex'), state: { d: [0,1,0], f: [1,0,0] } }, ack => { clearTimeout(timer); resolve(ack); });
  });
  const first = await join(a), appeared = next(a, 'joined'), second = await join(b);
  assert.ok(first.id); assert.equal(second.players[0]?.id, first.id); assert.equal((await appeared).id, second.id);
  const movement = next(b, 'states');
  a.emit('state', { d: [0,1,0], f: [1,0,0], h: 1, sp: 2 });
  assert.ok((await movement).some(row => row[0] === first.id));
  await connect('/royale', '/royale-io/'); await connect('/royale', '/royale-io/');
  console.log(JSON.stringify({ websockets: 'passed', independentClients: 2, roomJoinAndVisibility: 'passed', movementSynchronization: 'passed', royaleNamespace: 'connected', browserUI: 'not tested', verifiedUserPointsFlow: 'requires two real World ID users' }));
} finally { sockets.forEach(socket => socket.disconnect()); }
