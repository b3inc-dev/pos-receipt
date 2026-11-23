import { test } from "node:test";
import assert from "node:assert/strict";
import { graphqlWithCustomerFallback, isProtectedCustomerDataError } from "./protectedCustomerData";

const DENIED = "This app is not approved to use the displayName field. See https://shopify.dev/docs/apps/launch/protected-customer-data for more details.";

function fakeAdmin(behaviour: (q: string) => unknown) {
  const calls: string[] = [];
  return {
    calls,
    graphql: async (q: string) => {
      calls.push(q);
      const r = behaviour(q);
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify(r));
    },
  };
}

test("保護された顧客データのエラーを見分ける", () => {
  assert.equal(isProtectedCustomerDataError([{ message: DENIED }]), true);
  assert.equal(isProtectedCustomerDataError([{ message: "Throttled" }]), false);
  assert.equal(isProtectedCustomerDataError(undefined), false);
});

test("errors で断られたら名前なしで読み直す", async () => {
  const admin = fakeAdmin((q) => (q === "FULL" ? { errors: [{ message: DENIED }] } : { data: { ok: 1 } }));
  const json = await graphqlWithCustomerFallback(admin, "FULL", "LITE", {});
  assert.deepEqual(json, { data: { ok: 1 } });
  assert.deepEqual(admin.calls, ["FULL", "LITE"]);
});

test("例外で断られても名前なしで読み直す", async () => {
  const admin = fakeAdmin((q) => (q === "FULL" ? new Error(DENIED) : { data: { ok: 2 } }));
  const json = await graphqlWithCustomerFallback(admin, "FULL", "LITE", {});
  assert.deepEqual(json, { data: { ok: 2 } });
});

test("ほかのエラーは読み直さない", async () => {
  const admin = fakeAdmin(() => new Error("boom"));
  await assert.rejects(graphqlWithCustomerFallback(admin, "FULL", "LITE", {}), /boom/);
  assert.deepEqual(admin.calls, ["FULL"]);
});

test("許可があればそのまま 1 回で読む", async () => {
  const admin = fakeAdmin(() => ({ data: { ok: 3 } }));
  await graphqlWithCustomerFallback(admin, "FULL", "LITE", {});
  assert.deepEqual(admin.calls, ["FULL"]);
});
