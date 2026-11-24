import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { syncConnectionState } from "./ciaraSyncConnection";

describe("ciara sync connection status", () => {
  for (const lastOk of [false, true]) {
    it(`does not report connected when scheduler is unavailable (lastOk=${lastOk})`, () => {
      assert.equal(syncConnectionState(true, true, "off", lastOk), "off");
      assert.equal(syncConnectionState(true, true, "starting", lastOk), "starting");
      assert.equal(syncConnectionState(true, true, "failed", lastOk), "failed");
      assert.equal(syncConnectionState(false, true, "running", lastOk), "disabled");
      assert.equal(syncConnectionState(true, false, "running", lastOk), "off");
    });
  }
  it("requires running scheduler and successful import", () => {
    assert.equal(syncConnectionState(true, true, "running", false), "pending");
    assert.equal(syncConnectionState(true, true, "running", true), "connected");
  });
});
