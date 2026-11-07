import { start } from "./index.js";
start().catch((e) => { console.error('Backend startup failed:', e.message); process.exitCode = 1; });
