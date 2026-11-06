// Tiny persistent collections for the shared economy (shops, orders, invoices, forum, ads).
// One JSON file per collection, written atomically (temp file + rename) and debounced, so a burst
// of changes is one write and a crash never leaves a half-written file. Fine for a hackathon-sized
// world; swap for a database for anything bigger.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

export class Collection {
  constructor(dir, name, { delayMs = 150 } = {}) {
    this.file = dir ? join(dir, `${name}.json`) : null;
    this.map = new Map();
    this.delayMs = delayMs;
    this.timer = null;
    if (dir) mkdirSync(dir, { recursive: true });
    if (this.file && existsSync(this.file)) for (const v of JSON.parse(readFileSync(this.file, "utf8"))) this.map.set(v.id, v);
  }
  get(id) {
    return this.map.get(id) ?? null;
  }
  all() {
    return [...this.map.values()];
  }
  where(fn) {
    return this.all().filter(fn);
  }
  put(v) {
    this.map.set(v.id, v);
    this.save();
    return v;
  }
  delete(id) {
    this.map.delete(id);
    this.save();
  }
  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.all()));
    renameSync(tmp, this.file);
  }
}
