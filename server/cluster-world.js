/** Share the existing interest-managed world across Function instances.
 * The official Postgres adapter handles broadcast, discovery and node heartbeats.
 * Profiles are server-to-server only. Public packets still pass through pub().
 */
export function clusterWorld(world, rooms, pool) {
  const seen = new Map();
  const local = (p) => !!world.sockets.get(p.sock)?.connected;
  const upsert = (profiles) => {
    for (const p of profiles) {
      if (!p?.id || !p.room || !p.sock) continue;
      if (!rooms.has(p.room)) rooms.set(p.room, new Map());
      const players = rooms.get(p.room), old = players.get(p.id);
      if (old?.sock !== p.sock && local(old || {})) {
        const previous = world.sockets.get(old.sock);
        Object.assign(old, p);
        previous.emit('replaced'); previous.disconnect(true);
      }
      const current = players.get(p.id);
      if (current) Object.assign(current, p, { dirty: true, farDirty: true });
      else players.set(p.id, { ...p, dirty: true, farDirty: true });
      seen.set(p.id, Date.now());
    }
  };
  const remove = ({ id, room, sock }) => {
    const p = rooms.get(room)?.get(id);
    if (p?.sock !== sock || local(p)) return;
    rooms.get(room).delete(id); seen.delete(id);
    if (!rooms.get(room).size) rooms.delete(room);
  };
  world.on('omen:profiles', upsert);
  world.on('omen:departure', remove);
  const heartbeat = setInterval(() => {
    const profiles = [...world.sockets.values()].map(s => s.data.profile).filter(p => p?.sock);
    world.serverSideEmit('omen:profiles', profiles);
    for (const players of rooms.values()) for (const p of players.values()) {
      if (local(p) || !seen.has(p.id) || Date.now() - seen.get(p.id) < 20_000) continue;
      remove(p); world.local.to(p.room).emit('left', { id: p.id, name: p.name });
    }
  }, 5000);
  heartbeat.unref();
  return {
    async lock() {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='10s'");
        await client.query('SELECT pg_advisory_xact_lock(1330464079)');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); client.release(); throw e; }
      return async () => { try { await client.query('COMMIT'); } finally { client.release(); } };
    },
    async refresh() {
      const profiles = (await world.fetchSockets()).map(s => s.data.profile).filter(p => p?.sock);
      const ids = new Set(profiles.map(p => p.id));
      for (const players of rooms.values()) for (const p of players.values()) if (!local(p) && p.sock && !ids.has(p.id)) remove(p);
      upsert(profiles.filter(p => !world.sockets.has(p.sock)));
    },
    publish(profiles) { if (profiles.length) world.serverSideEmit('omen:profiles', profiles); },
    depart(p) { world.serverSideEmit('omen:departure', p); },
    close() { clearInterval(heartbeat); },
  };
}
