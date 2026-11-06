// Production entry for the Final Block build: the human gate / ChaiPay / predictions routes first,
// then Codex's full gateway (needs DATABASE_URL). Without DATABASE_URL it runs "lite": the built
// game from dist/ plus the Final Block routes only — enough for the demo journey.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFinalBlock } from "./final-block.js";
import { mountFinalRoutes } from "./final-routes.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8787);
const final = createFinalBlock();
mountFinalRoutes(final);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".glb": "model/gltf-binary", ".wasm": "application/wasm", ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".webp": "image/webp", ".ico": "image/x-icon" };
async function serveStatic(pathname, res) {
  const dist = join(ROOT, "dist");
  const file = normalize(join(dist, decodeURIComponent(pathname === "/" ? "/index.html" : pathname)));
  if (!file.startsWith(dist + sep)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}

if (process.env.DATABASE_URL) {
  const { createGateway, createNotifier, logStatus } = await import("./index.js");
  const notifier = createNotifier();
  const app = createGateway({ onChange: notifier.onChange, notify: notifier.notify });
  await app.ready;
  const server = createServer(async (req, res) => (await final(req, res)) || app(req, res));
  notifier.attach(server, app.community, app.database, app.worldIdentity);
  server.listen(PORT, "0.0.0.0", () => logStatus(`on http://localhost:${PORT} (+ final block)`));
} else {
  const server = createServer(async (req, res) => {
    if (await final(req, res)) return;
    if (req.url.startsWith("/api/")) return res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "lite_mode", message: "This route needs the full backend (DATABASE_URL)." }));
    serveStatic(new URL(req.url, "http://x").pathname, res);
  });
  server.listen(PORT, "0.0.0.0", () => console.log(`OMEN Final Block (lite: no DATABASE_URL) on http://localhost:${PORT}`));
}
