import assert from "node:assert/strict";

/** Test boundary only; this function opens no socket and imports no DB client. */
export function isolatedPostgresUrl(env = process.env) {
  assert.equal(env.ISOLATED_PG_ACCEPTANCE, "1", "Explicit isolated PostgreSQL opt-in required");
  assert.equal(env.CI, "true", "Isolated PostgreSQL requires CI=true");
  assert.equal(env.GITHUB_ACTIONS, "true", "Isolated PostgreSQL requires GITHUB_ACTIONS=true");
  const value = env.ISOLATED_PG_ACCEPTANCE_URL;
  assert.equal(typeof value, "string", "Explicit isolated PostgreSQL URL required");
  assert.equal(env.DATABASE_URL, value, "Isolated and Prisma database URLs must match");
  assert.match(value, /^(?:postgresql|postgres):\/\/postgres@(?:localhost|127\.0\.0\.1):5432\/postgres$/, "Only the disposable PostgreSQL service URL is allowed");
  return value;
}
