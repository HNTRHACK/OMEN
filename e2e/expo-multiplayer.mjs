// The production Expo page against the real PostgreSQL gateway and real WebSockets.
// Build first. TEST_DATABASE_URL must be a disposable PostgreSQL database.
// CHROME_PATH overrides the browser executable; screenshots/results go to SHOTS.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDatabase } from '../server/postgres.js';
import { createGateway, createNotifier } from '../server/index.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database.');
const pg = createRequire(new URL('../server/package.json', import.meta.url))('pg');
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const schema = 'expo_e2e_' + randomBytes(8).toString('hex');
const shots = resolve(process.env.SHOTS || 'artifacts/expo-multiplayer');
mkdirSync(shots, { recursive: true });
const results = {}, errors = [], frames = [];
let database, app, server, rt, browser;
const check = (name, detail = true) => { results[name] = detail; console.log('PASS', name, JSON.stringify(detail)); };
const wait = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 30000 });

try {
  await admin.query('CREATE SCHEMA ' + schema);
  const url = new URL(process.env.TEST_DATABASE_URL); url.searchParams.set('options', '-c search_path=' + schema);
  database = createDatabase(url.href); await database.migrate();
  const notifier = createNotifier();
  app = createGateway({ database, legacyDir: null, notify: notifier.notify, onChange: notifier.onChange }); await app.ready;
  server = createServer(app); rt = notifier.attach(server, app.community, database);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.CHROME_PATH || (existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
  browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  const open = async (name, viewport = { width: 1280, height: 800 }) => {
    const ctx = await browser.newContext({ viewport });
    await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, r => r.abort());
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(name + ': ' + e.stack));
    page.on('websocket', ws => {
      assert.equal(new URL(ws.url()).host, new URL(base).host);
      ws.on('framesent', f => frames.push({ name, direction: 'sent', payload: String(f.payload) }));
      ws.on('framereceived', f => frames.push({ name, direction: 'received', payload: String(f.payload) }));
    });
    const enter = async () => {
      await wait(page, () => !!window.__expo);
      await page.fill('#ex-name', name); await page.click('#ex-enter');
      await wait(page, () => window.__expo.mode === 'play' && window.__expo.net.connected);
    };
    await page.goto(base + '/expo.html'); await enter();
    return { ctx, page, enter };
  };
  const snapshot = page => page.evaluate(() => {
    const e = window.__expo;
    return { id: e.net.id, room: e.net.room, online: e.net.online, connected: e.net.connected,
      me: { x: e.me.x, y: e.me.y, z: e.me.z },
      remotes: [...e.net.remotes.values()].map(r => {
        const rect = r.tag.getBoundingClientRect();
        return { id: r.id, name: r.name, visible: r.c.group.visible, inScene: r.c.group.parent === e.scene,
          position: r.c.group.position.toArray(), packets: r.buf.length, tagVisible: !r.tag.hidden && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight };
      }) };
  });
  const A = await open('Asha');
  assert.equal((await snapshot(A.page)).online, 1); check('first guest is alone; NPCs are not counted');
  // B deliberately arrives after A is already inside the active scene.
  const B = await open('Ravi');
  for (const p of [A.page, B.page]) await wait(p, () => window.__expo.net.online === 2 && [...window.__expo.net.remotes.values()].some(r => r.c.group.visible && r.buf.length));
  await A.page.waitForTimeout(600);
  const a = await snapshot(A.page), b = await snapshot(B.page);
  assert.notEqual(a.id, b.id); assert.equal(a.room, 'omen-expo'); assert.equal(a.room, b.room);
  assert.equal(a.remotes[0].id, b.id); assert.equal(b.remotes[0].id, a.id);
  assert.ok(Math.hypot(a.me.x - b.me.x, a.me.z - b.me.z) >= 2.3);
  for (const s of [a, b]) { assert.equal(s.remotes.length, 1); assert.ok(s.remotes[0].inScene && s.remotes[0].tagVisible); assert.ok(s.remotes[0].position[1] >= 0); }
  assert.equal(frames.filter(f => f.name === 'Asha' && f.direction === 'sent' && f.payload.includes('"join"')).length, 1);
  assert.equal(frames.filter(f => f.name === 'Ravi' && f.direction === 'sent' && f.payload.includes('"join"')).length, 1);
  check('same public Expo URL, distinct guests, single joins and separate visible arrival positions', { a, b });
  await A.page.screenshot({ path: resolve(shots, 'asha-sees-ravi.png') });
  await B.page.screenshot({ path: resolve(shots, 'ravi-sees-asha.png') });
  assert.ok(await A.page.locator('#feed').innerText().then(t => t.includes('Ravi joined')));
  check('join notification is real');

  const move = async (walker, observer, key, id) => {
    const before = (await snapshot(observer)).remotes.find(r => r.id === id).position;
    await walker.keyboard.down(key); await walker.waitForTimeout(1000); await walker.keyboard.up(key);
    await observer.waitForTimeout(900);
    const after = (await snapshot(observer)).remotes.find(r => r.id === id).position;
    const actual = (await snapshot(walker)).me;
    const distance = Math.hypot(...after.map((v, i) => v - before[i]));
    const error = Math.hypot(after[0] - actual.x, after[1] - actual.y, after[2] - actual.z);
    assert.ok(distance > 0.8, `remote moved only ${distance} m`); assert.ok(error < 0.08, `remote error ${error} m`);
    return { movedMetres: distance, errorMetres: error };
  };
  check('B sees A move via real state packets', await move(A.page, B.page, 'd', a.id));
  check('A sees B move via real state packets', await move(B.page, A.page, 'w', b.id));
  assert.ok(frames.some(f => f.direction === 'received' && f.payload.includes('"state"')));

  const beforeRefresh = (await snapshot(B.page)).me;
  await B.page.reload(); await B.enter();
  await wait(A.page, id => window.__expo.net.online === 2 && window.__expo.net.remotes.has(id), b.id);
  await B.page.waitForTimeout(800);
  const refreshed = await snapshot(B.page);
  assert.equal(refreshed.id, b.id); assert.equal(refreshed.remotes.length, 1);
  assert.ok(Math.hypot(refreshed.me.x - beforeRefresh.x, refreshed.me.z - beforeRefresh.z) < 0.08);
  assert.equal((await snapshot(A.page)).remotes.filter(r => r.id === b.id).length, 1);
  check('refresh preserves guest identity, last position and exactly one remote');

  const socket = [...rt.io.of('/world').sockets.values()].find(s => s.data.playerId === b.id);
  const oldSocketId = socket.id;
  socket.conn.close(); // Real transport failure, not a simulated player or fake state.
  await wait(A.page, () => window.__expo.net.online === 1);
  await wait(B.page, () => window.__expo.net.connected && window.__expo.net.online === 2);
  assert.notEqual([...rt.io.of('/world').sockets.values()].find(s => s.data.playerId === b.id).id, oldSocketId);
  assert.equal((await snapshot(B.page)).id, b.id);
  assert.equal((await snapshot(A.page)).remotes.filter(r => r.id === b.id).length, 1);
  check('transport reconnect restores both directions; disconnected ghost is excluded from online count');
  check('movement after reconnect', await move(B.page, A.page, 's', b.id));
  await A.page.screenshot({ path: resolve(shots, 'reconnected-lobby.png') });

  const C = await open('Meera', { width: 390, height: 844 });
  await wait(C.page, () => window.__expo.net.online === 3 && window.__expo.net.remotes.size === 2 && [...window.__expo.net.remotes.values()].every(r => r.c.group.visible));
  // Narrow portrait view: use the real drag-to-look control to face the people
  // to our left, then verify their names are actually inside the viewport.
  await C.page.mouse.move(350, 420); await C.page.mouse.down();
  await C.page.mouse.move(150, 420, { steps: 12 }); await C.page.mouse.up();
  await C.page.waitForTimeout(500);
  const mobile = await snapshot(C.page); assert.notEqual(mobile.id, a.id); assert.notEqual(mobile.id, b.id);
  assert.ok(mobile.remotes.every(r => r.tagVisible && r.inScene && r.visible));
  await C.page.screenshot({ path: resolve(shots, 'mobile-late-join.png') });
  check('mobile-sized late guest sees both real players after drag-to-look', mobile);
  await C.ctx.close();
  await wait(A.page, () => window.__expo.net.online === 2);
  await wait(A.page, () => [...document.querySelectorAll('#feed li')].some(n => n.textContent.includes('Meera left')));
  assert.equal((await snapshot(A.page)).remotes.length, 1);
  check('online count and leave notification match disconnected humans');

  assert.deepEqual(errors, []);
  assert.equal(rt.stats().players, 2);
  check('no page errors; server has exactly two remaining human players');
  writeFileSync(resolve(shots, 'results.json'), JSON.stringify({ results, errors, transport: 'real same-origin WebSocket over loopback HTTP', frames: frames.filter(f => /"(join|joined|state|presence|left)"/.test(f.payload)).length }, null, 2));
  console.log('ALL PASS; screenshots:', shots);
} finally {
  await browser?.close();
  if (rt) await new Promise(r => rt.io.close(r));
  if (server?.listening) await new Promise(r => server.close(r));
  if (app) await app.close(); else await database?.close();
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end();
}
