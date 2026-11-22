/**
 * 会員証の LINE ID トークンの確認（#26 の引き継ぎ）。
 * - 期限切れは、トークンの exp が本当に過ぎているときだけ（本文の「expired」の文字では決めない）
 * - 429・5xx・通信の失敗は「LINE が使えない」（期限切れ・認証の失敗にしない）
 * - LINE の答えの本文・トークン・例外の文はログに出さない
 */
import assert from "node:assert/strict";
import test from "node:test";
import { classifyLineVerifyFailure, readIdTokenExpMs, verifyLineIdToken } from "../lib/line.server";

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: Record<string, unknown>) => `${b64url({ alg: "HS256" })}.${b64url(payload)}.c2ln`;
const expired = jwt({ sub: "Uxxxxxxxx", exp: Math.floor(NOW / 1000) - 600 });
const fresh = jwt({ sub: "Uxxxxxxxx", exp: Math.floor(NOW / 1000) + 600 });
const lineBody = (description: string) => JSON.stringify({ error: "invalid_request", error_description: description });

test("readIdTokenExpMs: JWT の exp を読む・読めなければ null", () => {
  assert.equal(readIdTokenExpMs(fresh), (Math.floor(NOW / 1000) + 600) * 1000);
  for (const bad of ["", "abc", "a.b", "a.!!!.c", `${b64url({})}.${b64url({ exp: "x" })}.s`, `${b64url({})}.${b64url({})}.s`]) {
    assert.equal(readIdTokenExpMs(bad), null, bad);
  }
});

test("classifyLineVerifyFailure: 期限切れは exp が過ぎているときだけ", () => {
  assert.equal(
    classifyLineVerifyFailure({ status: 400, bodyText: lineBody("IdToken expired."), idToken: expired, nowMs: NOW }).error,
    "ID_TOKEN_EXPIRED"
  );
  // 本文が「expired」でも、トークンの期限が残っていれば期限切れにしない
  assert.equal(
    classifyLineVerifyFailure({ status: 400, bodyText: lineBody("IdToken expired."), idToken: fresh, nowMs: NOW }).error,
    "LINE_AUTH_FAILED"
  );
  // 本文に expired が無くても、exp が過ぎていて invalid_request なら期限切れ
  assert.equal(
    classifyLineVerifyFailure({ status: 400, bodyText: lineBody("Invalid IdToken."), idToken: expired, nowMs: NOW }).error,
    "ID_TOKEN_EXPIRED"
  );
  // exp を読めないトークンは、本文に expired とあっても期限切れにしない
  assert.equal(
    classifyLineVerifyFailure({ status: 400, bodyText: lineBody("IdToken expired."), idToken: "not-a-jwt", nowMs: NOW }).error,
    "LINE_AUTH_FAILED"
  );
  // invalid_request でない 400（client_id の違いなど）は認証の失敗
  assert.equal(
    classifyLineVerifyFailure({
      status: 400,
      bodyText: JSON.stringify({ error: "invalid_client", error_description: "expired" }),
      idToken: expired,
      nowMs: NOW,
    }).error,
    "LINE_AUTH_FAILED"
  );
  // 期限のすぐあと（時計のずれの範囲）は期限切れと言わない
  const justNow = jwt({ exp: Math.floor(NOW / 1000) - 5 });
  assert.equal(
    classifyLineVerifyFailure({ status: 400, bodyText: lineBody("x"), idToken: justNow, nowMs: NOW }).error,
    "LINE_AUTH_FAILED"
  );
});

test("classifyLineVerifyFailure: 429・5xx は LINE が使えない（本文が expired でも）", () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(
      classifyLineVerifyFailure({ status, bodyText: lineBody("IdToken expired."), idToken: expired, nowMs: NOW }).error,
      "LINE_UNAVAILABLE",
      String(status)
    );
  }
});

test("classifyLineVerifyFailure: ログの行は HTTP の番号と決まった error の名前だけ", () => {
  const r = classifyLineVerifyFailure({
    status: 400,
    bodyText: JSON.stringify({ error: "invalid_request", error_description: "secret-detail token=abc" }),
    idToken: expired,
    nowMs: NOW,
  });
  assert.equal(r.logLine, "[member-card] ID_TOKEN_EXPIRED: status=400 error=invalid_request");
  const odd = classifyLineVerifyFailure({
    status: 401,
    bodyText: JSON.stringify({ error: "Bad <script> secret-detail" }),
    idToken: fresh,
    nowMs: NOW,
  });
  assert.equal(odd.logLine, "[member-card] LINE verify failed: status=401", "形の違う error の名前は出さない");
  const plain = classifyLineVerifyFailure({ status: 400, bodyText: "plain text secret-detail", idToken: fresh, nowMs: NOW });
  assert.ok(!plain.logLine.includes("secret-detail"));
});

test("verifyLineIdToken: 本文・トークン・例外の文をログに出さない", async (t) => {
  const prev = process.env.LINE_CHANNEL_ID;
  process.env.LINE_CHANNEL_ID = "fixture-channel";
  t.after(() => {
    if (prev === undefined) delete process.env.LINE_CHANNEL_ID;
    else process.env.LINE_CHANNEL_ID = prev;
  });
  const logged: string[] = [];
  const keep = (...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? `${a.name}:${a.message}` : String(a))).join(" "));
  };
  t.mock.method(console, "warn", keep);
  t.mock.method(console, "error", keep);
  const fetchMock = t.mock.method(globalThis, "fetch");
  // ここは本当の時計（Date.now）で比べるので、今からの前後で作る
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = jwt({ sub: "Uxxxxxxxx", exp: nowSec - 600 });
  const fresh = jwt({ sub: "Uxxxxxxxx", exp: nowSec + 600 });

  const cases: Array<[() => Promise<Response>, string, string]> = [
    [async () => new Response(lineBody("IdToken expired. secret-detail"), { status: 400 }), expired, "ID_TOKEN_EXPIRED"],
    [async () => new Response(lineBody("IdToken expired. secret-detail"), { status: 400 }), fresh, "LINE_AUTH_FAILED"],
    [async () => new Response("upstream secret-detail", { status: 503 }), fresh, "LINE_UNAVAILABLE"],
    [
      async () => {
        throw new TypeError("fetch failed secret-detail");
      },
      fresh,
      "LINE_UNAVAILABLE",
    ],
  ];
  for (const [reply, token, expected] of cases) {
    fetchMock.mock.mockImplementation(reply);
    assert.deepEqual(await verifyLineIdToken(token), { ok: false, error: expected });
  }
  assert.equal(logged.length, cases.length);
  for (const line of logged) {
    assert.ok(!line.includes("secret-detail"), line);
    assert.ok(!line.includes(expired) && !line.includes(fresh), "トークンを出さない");
    assert.ok(!line.includes("fixture-channel"));
  }
});

test("verifyLineIdToken: 成功のときは今までどおり sub を返す", async (t) => {
  const prev = process.env.LINE_CHANNEL_ID;
  process.env.LINE_CHANNEL_ID = "fixture-channel";
  t.after(() => {
    if (prev === undefined) delete process.env.LINE_CHANNEL_ID;
    else process.env.LINE_CHANNEL_ID = prev;
  });
  t.mock.method(globalThis, "fetch", async () => Response.json({ sub: " U123 " }));
  assert.deepEqual(await verifyLineIdToken(fresh), { ok: true, sub: "U123" });
});
