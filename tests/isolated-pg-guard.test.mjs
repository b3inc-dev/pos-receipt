import assert from "node:assert/strict";
import test from "node:test";
import { isolatedPostgresUrl } from "./helpers/isolated-pg-guard.mjs";

const valid = (url = "postgresql://postgres@localhost:5432/postgres") => ({
  CI: "true", GITHUB_ACTIONS: "true", ISOLATED_PG_ACCEPTANCE: "1",
  DATABASE_URL: url, ISOLATED_PG_ACCEPTANCE_URL: url,
});
test("only explicit GitHub Actions loopback PostgreSQL service URLs are accepted without connecting", () => {
  for (const protocol of ["postgresql", "postgres"]) for (const host of ["localhost", "127.0.0.1"]) {
    const url = protocol + "://postgres@" + host + ":5432/postgres";
    assert.equal(isolatedPostgresUrl(valid(url)), url);
  }
});
test("missing CI flags, opt-in, URLs and mismatched Prisma URL fail before client creation", () => {
  for (const key of Object.keys(valid())) {
    const env = valid(); delete env[key];
    assert.throws(() => isolatedPostgresUrl(env));
  }
  for (const key of ["CI", "GITHUB_ACTIONS", "ISOLATED_PG_ACCEPTANCE"]) {
    assert.throws(() => isolatedPostgresUrl({ ...valid(), [key]: "false" }));
  }
  assert.throws(() => isolatedPostgresUrl({ ...valid(), DATABASE_URL: "postgresql://postgres@remote.invalid:5432/postgres" }));
});
test("alternate hosts, protocols, ports, users, passwords, databases, query options and fragments fail closed", () => {
  for (const url of [
    "mysql://postgres@localhost:5432/postgres", "file:///postgres",
    "postgresql://postgres@remote.invalid:5432/postgres",
    "postgresql://postgres@localhost:5433/postgres", "postgresql://postgres@localhost/postgres",
    "postgresql://other@localhost:5432/postgres", "postgresql://postgres:secret@localhost:5432/postgres",
    "postgresql://postgres@localhost:5432/live", "postgresql://postgres@localhost:5432/postgres/extra",
    "postgresql://postgres@localhost:5432/postgres?schema=live",
    "postgresql://postgres@localhost:5432/postgres?host=remote.invalid",
    "postgresql://postgres@localhost:5432/postgres?", "postgresql://postgres@localhost:5432/postgres#",
    "postgresql://postgres@localhost:5432/postgres#live",
    " postgresql://postgres@localhost:5432/postgres", "postgresql://postgres@localhost:5432/postgres\n",
  ]) assert.throws(() => isolatedPostgresUrl(valid(url)));
});
