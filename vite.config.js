import { defineConfig } from "vite";

// In dev, the payment gateway API runs inside Vite's server, so `npm run dev` is one process on
// one port. In production, `npm start` serves the built game and the API from server/main.js.
const gateway = () => ({
  name: "omen-gateway",
  async configureServer(server) {
    // Plain Node import: the gateway is ordinary server code, not something Vite should transform.
    const { createGateway, createNotifier, logStatus } = await import(new URL("./server/index.js", import.meta.url).href);
    const notifier = createNotifier();
    const handle = createGateway({ onChange: notifier.onChange, notify: notifier.notify });
    // Socket.IO (multiplayer + merchant notifications) rides on Vite's own HTTP server.
    if (server.httpServer) notifier.attach(server.httpServer, handle.community);
    logStatus("mounted at /api (dev)");
    server.middlewares.use((req, res, next) => (req.url.startsWith("/api/") || req.url.startsWith("/uploads/") ? handle(req, res) : next()));
  },
});

export default defineConfig({
  base: "./",
  plugins: [gateway()],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    // pages: the game, a merchant's ledger (its own device), moderation, and the Mumbai venue
    rollupOptions: { input: { main: "index.html", merchant: "merchant.html", moderate: "moderate.html", expo: "expo.html" } },
  },
});
