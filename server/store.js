// Tiny write-through JSON store. Enough for a demo gateway; swap for a database in production.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

export class Store {
  constructor(dir) {
    this.file = dir ? join(dir, "payments.json") : null;
    this.items = new Map();
    this.usedTx = new Set(); // a tx hash can settle one payment only
    if (this.file && existsSync(this.file)) {
      for (const p of JSON.parse(readFileSync(this.file, "utf8"))) {
        this.items.set(p.id, p);
        if (p.txHash) this.usedTx.add(p.txHash.toLowerCase());
      }
    }
    if (dir) mkdirSync(dir, { recursive: true });
  }
  get(id) {
    return this.items.get(id) || null;
  }
  put(p) {
    this.items.set(p.id, p);
    this.flush();
    return p;
  }
  claimTx(hash) {
    const h = hash.toLowerCase();
    if (this.usedTx.has(h)) return false;
    this.usedTx.add(h);
    return true;
  }
  releaseTx(hash) {
    this.usedTx.delete(hash.toLowerCase());
  }
  byPayer(addr) {
    const a = String(addr).toLowerCase();
    return [...this.items.values()].filter((p) => p.payer?.toLowerCase() === a).sort((x, y) => y.createdAt - x.createdAt);
  }
  byMerchant(id) {
    return [...this.items.values()].filter((p) => p.merchant?.id === id).sort((x, y) => y.createdAt - x.createdAt);
  }
  flush() {
    if (!this.file) return;
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify([...this.items.values()], null, 1));
    renameSync(tmp, this.file);
  }
}
