// Regression: a gateway that started before `manage.js migrate` finished must start serving once the
// migrations are in, without a restart, and must keep refusing (503) while they are not.
//   READY_TEST_DATABASE_URL=postgres://omen@127.0.0.1:55433/omen_ready_test node --test test/ready-recovery.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = process.env.READY_TEST_DATABASE_URL;

test("gateway recovers after migrations complete; never serves before", { skip: !URL_ || !/_test$/.test(URL_ || "") ? "set READY_TEST_DATABASE_URL to a throwaway *_test database" : false }, async () => {
  const pg = (await import("../server/node_modules/pg/lib/index.js")).default;
  const admin = new pg.Client({ connectionString: URL_.replace(/\/[^/]+$/, "/postgres") });
  await admin.connect();
  const name = URL_.split("/").pop();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const { createGateway } = await import("../server/index.js");
  const { createDatabase } = await import("../server/postgres.js");
  const app = createGateway({ database: createDatabase(URL_), legacyDir: mkdtempSync(join(tmpdir(), "omen-legacy-")) });
  const call = () =>
    new Promise((resolve) => {
      const res = { status: 0, writeHead(s) { this.status = s; return this; }, setHeader() {}, getHeader() {}, end() { resolve(this.status); } };
      app({ method: "GET", url: "/api/payments/config", headers: { host: "x" }, socket: { remoteAddress: "127.0.0.1" }, on() {} }, res);
    });
  assert.equal(await call(), 503, "unmigrated database: refuse");
  execFileSync(process.execPath, ["server/manage.js", "migrate"], { env: { ...process.env, DATABASE_URL: URL_ }, stdio: "pipe" });
  await new Promise((r) => setTimeout(r, 2100)); // the re-check is throttled to once per 2 s
  const after = await call();
  assert.notEqual(after, 503, "after migrate: the request reaches the router, no restart needed");
  assert.ok(after > 0);
  await app.close();
});
