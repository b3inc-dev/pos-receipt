import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ciaraConnectionView } from "./ciaraSyncConnection";

const texts = { job: "1 時間ごとの取り込み", running: "動いています。", turnOn: "オンに", notReady: "準備まだ", tryNow: "押して" };
const ok = { ok: true, message: "変わった予算はありませんでした" };
const view = (scheduler: Parameters<typeof ciaraConnectionView>[0]["scheduler"], last: { ok: boolean; message: string } | null = ok, more = {}) =>
  ciaraConnectionView({ hasSecret: true, enabled: true, last, scheduler, texts, ...more });

describe("ciaraConnectionView", () => {
  it("動いていて前回が成功なら、つながっています", () => {
    const v = view({ state: "running" });
    assert.equal(v.connected, true);
    assert.deepEqual(v.badge, { tone: "success", label: "つながっています" });
    assert.equal(v.note, "動いています。");
  });

  it("前回が成功でも、始めている途中ならつながっていますにしない", () => {
    const v = view({ state: "starting" });
    assert.equal(v.connected, false);
    assert.equal(v.badge.label, "まだです");
    assert.match(v.note, /1 時間ごとの取り込みを始めています/);
  });

  it("前回が成功でも、まだ始めていない（off）ならつながっていますにしない", () => {
    const v = view({ state: "off" });
    assert.equal(v.connected, false);
    assert.match(v.note, /を始めています/);
  });

  it("止まっているときは赤で知らせる", () => {
    const v = view({ state: "failed", hadFailure: true });
    assert.equal(v.connected, false);
    assert.equal(v.stopped, true);
    assert.deepEqual(v.badge, { tone: "critical", label: "止まっています" });
    assert.match(v.note, /止まっています。5 分ほどで自動でもう一度始めます/);
  });

  it("止まったあと、画面を開いてもう一度始めている途中でも、止まっていたことを出す", () => {
    const v = view({ state: "starting", hadFailure: true });
    assert.equal(v.stopped, true);
    assert.equal(v.badge.tone, "critical");
    assert.match(v.note, /止まっていたので、もう一度始めています/);
  });

  it("動き出したら、前の失敗は出さない", () => {
    assert.equal(view({ state: "running", hadFailure: false }).connected, true);
  });

  it("動いていて前回が失敗なら、その理由の文を出す", () => {
    const v = view({ state: "running" }, { ok: false, message: "ciara-system につながりませんでした" });
    assert.equal(v.connected, false);
    assert.equal(v.note, "ciara-system につながりませんでした");
  });

  it("まだ一度も読んでいなければ、今すぐの案内", () => {
    assert.equal(view({ state: "running" }, null).note, "押して");
  });

  it("オフ・準備まだのときは、仕事の状態より先にそれを出す", () => {
    assert.equal(view({ state: "failed", hadFailure: true }, ok, { enabled: false }).note, "オンに");
    assert.equal(view({ state: "failed", hadFailure: true }, ok, { hasSecret: false }).note, "準備まだ");
  });
});



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
