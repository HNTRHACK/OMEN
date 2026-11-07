import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sniff, MAX_BYTES } from './images.js';

const context = new AsyncLocalStorage();
const LOCK = 1330464078;
export const COLLECTIONS = ['payments', 'shops', 'orders', 'invoices', 'threads', 'posts', 'ads', 'mutes', 'accounts'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function createDatabase(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required. Run the backend migrations and legacy import before starting.');
  const pool = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000 });
  pool.on('error', (e) => console.error('PostgreSQL connection error:', e.code));
  const state = () => {
    const tx = context.getStore();
    if (!tx || tx.database !== database) throw new Error('Economy access requires a database transaction');
    return tx;
  };
  const database = {
    pool,
    state,
    collection(name) {
      const tx = state();
      if (!tx.collections.has(name)) tx.collections.set(name, new Map());
      return tx.collections.get(name);
    },
    defer(fn) { state().effects.push(fn); },
    image(dir, { buf, info }) {
      const name = randomUUID().replaceAll('-', '') + '.' + info.ext;
      state().uploads.push({ name, buf, type: info.type });
      return { file: name };
    },
    async transaction(fn) {
      if (context.getStore()?.database === database) return fn();
      const client = await pool.connect();
      const tx = { database, client, collections: new Map(), effects: [], uploads: [] };
      let result;
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '30s'");
        // ponytail: one economy lock preserves the existing synchronous domain model.
        // Keep one web instance; partition by board/account when measured traffic requires it.
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
        const { rows } = await client.query('SELECT collection, id, data FROM economy_records');
        const before = new Map();
        for (const row of rows) {
          if (!tx.collections.has(row.collection)) tx.collections.set(row.collection, new Map());
          tx.collections.get(row.collection).set(row.id, row.data);
          before.set(`${row.collection}:${row.id}`, JSON.stringify(row.data));
        }
        result = await context.run(tx, fn);
        for (const [collection, records] of tx.collections) {
          for (const [id, data] of records) {
            const key = `${collection}:${id}`;
            const encoded = JSON.stringify(data);
            if (before.get(key) !== encoded) await client.query(
              'INSERT INTO economy_records(collection,id,data) VALUES($1,$2,$3) ON CONFLICT(collection,id) DO UPDATE SET data=EXCLUDED.data', [collection, id, encoded]);
            before.delete(key);
          }
        }
        for (const key of before.keys()) {
          const at = key.indexOf(':');
          await client.query('DELETE FROM economy_records WHERE collection=$1 AND id=$2', [key.slice(0, at), key.slice(at + 1)]);
        }
        for (const upload of tx.uploads) await client.query('INSERT INTO uploads(name,content_type,bytes) VALUES($1,$2,$3)', [upload.name, upload.type, upload.buf]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { client.release(); }
      // No socket notification or webhook can escape a failed transaction.
      for (const effect of tx.effects) {
        try { effect(); } catch (e) { console.error('Post-commit notification failed:', e.message); }
      }
      return result;
    },
    async migrate() {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
        await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
        const dir = fileURLToPath(new URL('./migrations/', import.meta.url));
        for (const name of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
          const sql = readFileSync(join(dir, name), 'utf8').replaceAll('\r\n', '\n');
          const hash = digest(sql);
          const old = (await client.query('SELECT digest FROM schema_migrations WHERE name=$1', [name])).rows[0];
          if (old && old.digest !== hash) throw new Error(`Applied migration changed: ${name}`);
          if (!old) {
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations(name,digest) VALUES($1,$2)', [name, hash]);
          }
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    },
    async verifyReady(legacyDir = null) {
      const dir = fileURLToPath(new URL('./migrations/', import.meta.url));
      for (const name of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
        const hash = digest(readFileSync(join(dir, name), 'utf8').replaceAll('\r\n', '\n'));
        const applied = (await pool.query('SELECT digest FROM schema_migrations WHERE name=$1', [name])).rows[0];
        if (!applied || applied.digest !== hash) throw new Error(`Run migrations before starting; missing or modified migration: ${name}`);
      }
      if (!legacyDir) return;
      for (const name of COLLECTIONS) {
        const path = join(legacyDir, `${name}.json`);
        if (!existsSync(path)) continue;
        const imported = (await pool.query('SELECT digest FROM legacy_imports WHERE source=$1', [name])).rows[0];
        if (!imported || imported.digest !== digest(readFileSync(path))) throw new Error(`Import/reconcile legacy ${name}.json before starting: node server/manage.js import`);
      }
    },
    async importLegacy(dir) {
      // Parse every source before beginning; malformed files must not cause a partial import.
      const sources = COLLECTIONS.flatMap((name) => {
        const path = resolve(dir, `${name}.json`);
        if (!existsSync(path)) return [];
        const raw = readFileSync(path);
        const records = JSON.parse(raw.toString('utf8'));
        if (!Array.isArray(records) || records.some((r) => !r || typeof r.id !== 'string' || !r.id) || new Set(records.map((r) => r.id)).size !== records.length)
          throw new Error(`Invalid or duplicate records: ${path}`);
        return [{ name, path, raw, records }];
      });
      return database.transaction(async () => {
        const { client } = state();
        let count = 0;
        for (const source of sources) {
          const hash = digest(source.raw);
          const old = (await client.query('SELECT digest FROM legacy_imports WHERE source=$1', [source.name])).rows[0];
          if (old) {
            if (old.digest !== hash) throw new Error(`Legacy source changed after import: ${source.name}. Reconcile manually; no overwrite performed.`);
            continue;
          }
          const records = database.collection(source.name);
          for (const record of source.records) {
            if (records.has(record.id)) throw new Error(`Import conflict: ${source.name}/${record.id}`);
            records.set(record.id, record);
            if (source.name === 'ads' && record.image) {
              if (!/^[a-f0-9]{32}\.(png|jpg)$/.test(record.image)) throw new Error('Unsafe legacy image name');
              const buf = readFileSync(join(dir, 'uploads', record.image));
              const info = sniff(buf);
              if (!info || buf.length > MAX_BYTES) throw new Error(`Invalid legacy image: ${record.image}`);
              await client.query('INSERT INTO uploads(name,content_type,bytes) VALUES($1,$2,$3) ON CONFLICT(name) DO NOTHING', [record.image, info.type, buf]);
            }
          }
          await client.query('INSERT INTO legacy_imports(source,digest,records) VALUES($1,$2,$3)', [source.name, hash, source.records.length]);
          count += source.records.length;
        }
        return count;
      });
    },
    close: () => pool.end(),
  };
  return database;
}
