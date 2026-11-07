import { config } from './config.js';

/** Private, authenticated DEMO payment notifications. Persistence and missed-event recovery use HTTP. */
export function attachBtcInr(io, service) {
  const namespace = io.of('/btcinr');
  let closed = false, pumping = false;
  const expire = (socket) => { socket.emit('btcinr:session-expired', { error: 'session_expired' }); socket.disconnect(true); };
  namespace.use(async (socket, next) => {
    try {
      const headers = socket.handshake.headers;
      if (headers.origin) {
        const origin = new URL(headers.origin);
        if (!['http:', 'https:'].includes(origin.protocol) || (origin.host !== headers.host && origin.origin !== config.allowedOrigin)) throw new Error('unauthorized');
      }
      socket.data.btcinr = await service.socketIdentity(socket.handshake); next();
    }
    catch { next(new Error('unauthorized')); }
  });
  namespace.on('connection', (socket) => {
    const who = socket.data.btcinr;
    if (who.customerId) socket.join('customer:' + who.customerId);
    if (who.merchantId) socket.join('merchant:' + who.merchantId);
    // No client event joins rooms, transfers value, modifies balances or confirms a payment.
  });
  const revoked = ({ merchantId, merchantSessionHash, sessionHash, accountId }) => {
    for (const socket of namespace.sockets.values()) {
      const who = socket.data.btcinr;
      if ((merchantId && who.merchantId === merchantId) || (merchantSessionHash && who.merchantSessionHash === merchantSessionHash)
        || (sessionHash && who.player?.sessionHash === sessionHash) || (accountId && who.player?.accountId === accountId)) expire(socket);
    }
  };
  const pump = async () => {
    if (closed || pumping) return;
    pumping = true;
    try {
      let count;
      do {
        count = await service.drainOutbox(async (row) => {
          for (const socket of await namespace.fetchSockets()) {
            const who = socket.data.btcinr;
            if (!(row.customer_id && row.customer_id === who.customerId) && !(row.merchant_id && row.merchant_id === who.merchantId)) continue;
            if (!await service.validSocket(who)) { expire(socket); continue; }
            if (!closed && socket.connected) socket.emit(row.event, row.payload);
          }
        });
      } while (!closed && count === 100);
    } catch (e) { if (!closed) console.error('DEMO outbox delivery deferred:', e.code || 'delivery_failed'); }
    finally { pumping = false; }
  };
  service.events.on('outbox', pump);
  service.events.on('revoked', revoked);
  service.worldIdentity?.events.on('revoked', revoked);
  const outboxTimer = setInterval(pump, 1000);
  const sessionTimer = setInterval(async () => {
    for (const socket of namespace.sockets.values()) {
      try { if (!await service.validSocket(socket.data.btcinr)) expire(socket); }
      catch { expire(socket); }
    }
  }, 10_000);
  outboxTimer.unref(); sessionTimer.unref();
  void pump();
  return () => {
    closed = true; clearInterval(outboxTimer); clearInterval(sessionTimer);
    service.events.off('outbox', pump); service.events.off('revoked', revoked);
    service.worldIdentity?.events.off('revoked', revoked);
  };
}
