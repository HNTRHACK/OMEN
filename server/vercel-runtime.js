import { createServer } from 'node:http';
import { createAdapter } from '@socket.io/postgres-adapter';
import pg from 'pg';
import { createDatabase } from './postgres.js';
import { createGateway, createNotifier } from './index.js';
import { createFinalBlock } from './final-block.js';
import { postgresFinalStore } from './final-postgres.js';
import { mountFinalRoutes } from './final-routes.js';

export async function createVercelRuntime({ database = null, clusterPool = null, finalOptions = {} } = {}) {
  const direct = process.env.DATABASE_URL_UNPOOLED;
  if (!clusterPool && (!direct || new URL(direct).hostname.includes('-pooler'))) throw new Error('A direct DATABASE_URL_UNPOOLED is required for realtime LISTEN/NOTIFY.');
  const secureUrl = value => {
    const url = new URL(value);
    if (url.hostname.endsWith('.neon.tech')) url.searchParams.set('sslmode', 'verify-full');
    return url.href;
  };
  database ||= createDatabase(secureUrl(process.env.DATABASE_URL));
  clusterPool ||= new pg.Pool({ connectionString: secureUrl(direct), max: 6, connectionTimeoutMillis: 10_000 });
  clusterPool.on('error', error => console.error('Realtime PostgreSQL connection failed:', error.code));
  const realtimeOptions = { clusterPool };
  const notifier = createNotifier({ realtimeOptions });
  // There is no workstation JSON import source inside a deployment.
  const app = createGateway({ database, legacyDir: null, onChange: notifier.onChange, notify: notifier.notify });
  try {
    await app.ready;
    const final = mountFinalRoutes(createFinalBlock({ ...finalOptions, store: postgresFinalStore(database.pool) }), { database });
    await final.royale.ready;
    const adapter = createAdapter(clusterPool, { channelPrefix: 'omen', tableName: 'socket_io_attachments',
      errorHandler: error => console.error('Socket.IO PostgreSQL coordination failed:', error.code || error.name) });
    realtimeOptions.adapter = adapter;
    const server = createServer(async (req, res) => {
      try {
        if (new URL(req.url, 'http://omen').pathname === '/api/deployment') {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ branch: process.env.VERCEL_GIT_COMMIT_REF || null, commit: process.env.VERCEL_GIT_COMMIT_SHA || null, points: 'free-nonredeemable', persistentIdentity: true, realtime: 'socket.io-postgres' }));
        }
        if (await final(req, res)) return;
        await app(req, res);
      } catch (error) {
        console.error('OMEN request failed:', error.code || error.name);
        if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: 'backend_unavailable' }));
      }
    });
    const world = notifier.attach(server, app.community, database, app.worldIdentity);
    const royale = final.royale.attach(server, { adapter });
    return { server, app, final, world, royale, async close() {
      await Promise.all([new Promise(r => world.io.close(r)), new Promise(r => royale.close(r))]);
      if (server.listening) await new Promise(r => server.close(r));
      await app.close(); await clusterPool.end();
    } };
  } catch (error) { await app.close(); await clusterPool.end(); throw error; }
}
