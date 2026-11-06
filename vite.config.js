import { defineConfig } from "vite";

// In dev, the payment gateway API runs inside Vite's server, so `npm run dev` is one process on
// one port. In production, `npm start` serves the built game and the API from server/final-main.js.
// The Final Block routes (human gate, ChaiPay tutorial payment, prediction booths) mount first and
// work on their own; Codex's full gateway also mounts when DATABASE_URL is set.
const gateway = () => ({
  name: "omen-gateway",
  async configureServer(server) {
    const { createFinalBlock } = await import(new URL("./server/final-block.js", import.meta.url).href);
    const { mountFinalRoutes } = await import(new URL("./server/final-routes.js", import.meta.url).href);
    const final = mountFinalRoutes(createFinalBlock());
    let handle = null;
    if (process.env.DATABASE_URL) {
      // Plain Node import: the gateway is ordinary server code, not something Vite should transform.
      const { createGateway, createNotifier, logStatus } = await import(new URL("./server/index.js", import.meta.url).href);
      const notifier = createNotifier();
      handle = createGateway({ onChange: notifier.onChange, notify: notifier.notify });
      // Socket.IO (multiplayer + merchant notifications) rides on Vite's own HTTP server.
      if (server.httpServer) notifier.attach(server.httpServer, handle.community);
      logStatus("mounted at /api (dev)");
    } else console.log("[omen] no DATABASE_URL: Final Block routes only (human gate, ChaiPay, predictions)");
    server.middlewares.use(async (req, res, next) => {
      if (!req.url.startsWith("/api/") && !req.url.startsWith("/uploads/")) return next();
      if (await final(req, res)) return;
      if (handle) return handle(req, res);
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "lite_mode", message: "This route needs the full backend (DATABASE_URL)." }));
    });
  },
});

export default defineConfig({
  base: "./",
  plugins: [gateway()],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    // pages: the game, a merchant's ledger (its own device), moderation, and the Mumbai venue
    rollupOptions: { input: { main: "index.html", merchant: "merchant.html", moderate: "moderate.html", expo: "expo.html", pay: "pay.html" } },
  },
});
