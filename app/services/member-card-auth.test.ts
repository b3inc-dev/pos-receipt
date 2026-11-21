import assert from "node:assert/strict";
import test from "node:test";
import { verifyLineIdToken } from "../lib/line.server";

test("会員証の期限切れと認証障害を区別し、応答本文をログへ出さない", async (t) => {
  const previousId = process.env.LINE_CHANNEL_ID;
  process.env.LINE_CHANNEL_ID = "fixture";
  t.after(() => {
    if (previousId === undefined) delete process.env.LINE_CHANNEL_ID;
    else process.env.LINE_CHANNEL_ID = previousId;
  });
  const warn = t.mock.method(console, "warn", () => {});
  const error = t.mock.method(console, "error", () => {});
  const request = t.mock.method(globalThis, "fetch");
  for (const [status, description, expected] of [
    [400, "IdToken expired.", "ID_TOKEN_EXPIRED"],
    [400, "Invalid client fixture-private-detail", "LINE_AUTH_FAILED"],
    [503, "IdToken expired.", "LINE_AUTH_FAILED"],
    [400, "Session expired.", "LINE_AUTH_FAILED"],
  ] as const) {
    request.mock.mockImplementation(async () => Response.json(
      { error: "invalid_request", error_description: description },
      { status },
    ));
    assert.deepEqual(await verifyLineIdToken("fixture-token"), { ok: false, error: expected });
  }
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments), [["[member-card] ID_TOKEN_EXPIRED"]]);
  assert.deepEqual(error.mock.calls.map((c) => c.arguments), [
    ["[member-card] LINE verify failed:", 400],
    ["[member-card] LINE verify failed:", 503],
    ["[member-card] LINE verify failed:", 400],
  ]);
});
