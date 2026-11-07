import { createVercelRuntime } from '../server/vercel-runtime.js';

const runtime = await createVercelRuntime();
// Export the HTTP server itself so Fluid compute handles WebSocket upgrades.
export default runtime.server;
