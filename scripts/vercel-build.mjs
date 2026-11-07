import { spawnSync } from 'node:child_process';
import { createDatabase } from '../server/postgres.js';
import { finalConfig } from '../server/final-block.js';

if (process.env.VERCEL_GIT_COMMIT_REF !== 'final-block') throw new Error('OMEN production builds require final-block; refusing another branch.');
if (process.env.VITE_SOCKET_PATH !== '/api/runtime') throw new Error('VITE_SOCKET_PATH must address the canonical realtime Function.');
if (!process.env.DATABASE_URL || !process.env.DATABASE_URL_UNPOOLED) throw new Error('Neon DATABASE_URL and DATABASE_URL_UNPOOLED are required.');
for (const key of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
  const url = new URL(process.env[key]);
  if (!url.hostname.endsWith('.neon.tech')) throw new Error(`${key} must use the existing Neon database.`);
  // Verify the server certificate. Never use sslmode=no-verify or rejectUnauthorized:false.
  url.searchParams.set('sslmode', 'verify-full');
  process.env[key] = url.href;
}
const world = finalConfig();
if (world.issues.length || world.environment !== 'production' || world.allowGuest) throw new Error('Production World ID credentials must be valid, production-only, with unverified guest bypass disabled.');
const database = createDatabase(process.env.DATABASE_URL_UNPOOLED);
try {
  await database.migrate();
  await database.verifyReady();
  console.log('Neon additive migrations verified:', (await database.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name).join(', '));
} finally { await database.close(); }
const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { stdio: 'inherit', env: process.env });
if (result.status !== 0) process.exit(result.status || 1);
