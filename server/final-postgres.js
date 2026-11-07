import { AsyncLocalStorage } from 'node:async_hooks';

/** Preserve the existing gate contract with a transactionally refreshed shared snapshot.
 * AsyncLocalStorage isolates simultaneous requests in one Fluid compute instance.
 * Responses are sent only after the session/avatar transaction commits.
 */
export function postgresFinalStore(pool) {
  const context = new AsyncLocalStorage();
  const initial = { humans: {}, sessions: {}, wallets: {}, signals: {} };
  const db = new Proxy({}, {
    get(_, key) { return (context.getStore()?.data || initial)[key]; },
    set(_, key, value) { (context.getStore()?.data || initial)[key] = value; return true; },
  });
  return {
    db,
    save() { context.getStore().dirty = true; },
    async run(fn) {
      if (context.getStore()) return fn();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='10s'");
        const { rows } = await client.query('SELECT data FROM final_block_state WHERE id=1 FOR UPDATE');
        if (!rows.length) throw new Error('Final Block migration is missing');
        const state = { data: rows[0].data, dirty: false };
        const result = await context.run(state, fn);
        if (state.dirty) await client.query('UPDATE final_block_state SET data=$1,updated_at=now() WHERE id=1', [JSON.stringify(state.data)]);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },
  };
}
