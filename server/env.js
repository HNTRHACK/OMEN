import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Match Vite's file precedence. Shell variables always win; values stay server-side.
export function loadServerEnv({ root = ROOT, env = process.env, mode } = {}) {
  const read = (name) => {
    const path = join(root, name);
    return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  };
  const base = { ...read('.env'), ...read('.env.local') };
  mode ||= env.NODE_ENV || base.NODE_ENV || 'development';
  const values = { ...base, ...read(`.env.${mode}`), ...read(`.env.${mode}.local`) };
  for (const [key, value] of Object.entries(values)) if (env[key] === undefined) env[key] = value;
  return env;
}

loadServerEnv();
