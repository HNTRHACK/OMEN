// Read-only release check. Does not provision, migrate, import, deploy, or print credentials.
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { config, ROOT } from '../server/config.js';
import { createDatabase } from '../server/postgres.js';

let database;
try {
  if (process.env.NODE_ENV !== 'production') throw new Error('Set NODE_ENV=production for this check.');
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required. Set it through the secret manager.');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT is invalid.');
  if (config.allowedOrigin && (new URL(config.allowedOrigin).protocol !== 'https:' || new URL(config.allowedOrigin).origin !== config.allowedOrigin)) throw new Error('ALLOWED_ORIGIN must be empty for same-origin hosting, or one exact HTTPS origin.');
  for (const page of ['index.html', 'expo.html', 'pay.html', 'merchant.html', 'moderate.html']) {
    await access(join(ROOT, 'dist', page));
    const html = await readFile(join(ROOT, 'dist', page), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"?#]+)/g)].map(m => m[1]);
    for (const asset of refs) await access(join(ROOT, 'dist', asset));
    console.log('PASS built page and entry assets:', page);
  }
  database = createDatabase(config.databaseUrl);
  const version = (await database.pool.query('SHOW server_version_num')).rows[0].server_version_num;
  if (Number(version) < 160000) throw new Error('PostgreSQL 16 or newer is required.');
  await database.verifyReady(config.dataDir);
  console.log('PASS PostgreSQL connectivity, migration checksums and available legacy-source readiness');
  console.log('PASS migration count:', (await readdir(join(ROOT, 'server/migrations'))).filter(n => n.endsWith('.sql')).length);
  console.log('PASS production settings; secrets omitted');
  if (existsSync(join(ROOT, '.git')) && execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim())
    console.log('MANUAL RELEASE GATE: worktree has pending changes; review and commit frozen source before a Git-based deployment.');
  console.log('World ID configured:', !!(config.worldId.clientId && config.worldId.clientSecret && config.worldId.redirectUri), '(optional; guests remain available)');
  console.log('BTC/INR pricing:', process.env.BTCINR_DEMO_INR_PER_BTC ? 'explicit configured-demo reference price' : 'CoinGecko availability required');
  console.log('READY for manual hosting validation; public HTTPS/WSS still requires post-deploy acceptance.');
} catch (error) {
  // Database/library errors can contain credentials: print only a stable code for those.
  console.error('NOT READY:', error.code ? error.code : error.message);
  process.exitCode = 1;
} finally { await database?.close(); }
