/**
 * 領収書の「再発行」を自動で選ぶ（T さん 2026-11-24）の試験
 * - POS: 前に発行した注文なら理由の 1 文を出してオンにする（extensions/common/receiptReissue.js）
 * - 管理画面: 外して発行したものを記録から読む（app/utils/receiptReissue.ts）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  issuedDayLabel,
  summarizePriorReceipts,
  reissueHelpText,
} from "../../extensions/common/receiptReissue.js";
import { receiptIdsIssuedWithoutReissue } from "./receiptReissue";

test("発行日の表し方: 今日・同じ年・違う年・おかしな値", () => {
  assert.equal(issuedDayLabel("2026-11-24", "2026-11-24"), "今日");
  assert.equal(issuedDayLabel("2026-11-20", "2026-11-24"), "11/20");
  assert.equal(issuedDayLabel("2025-12-31", "2026-01-02"), "2025/12/31");
  assert.equal(issuedDayLabel("", "2026-11-24"), "");
  assert.equal(issuedDayLabel("2026-11-20T00:00:00Z", "2026-11-24"), "");
});

test("発行の記録が無い注文: オンにしない・説明は今までのまま", () => {
  const s = summarizePriorReceipts([], "2026-11-24");
  assert.equal(s.issuedBefore, false);
  assert.equal(s.notice, "");
  assert.equal(
    reissueHelpText(s, false),
    "前に出した領収書を出し直すときだけ選びます。領収書に【再発行】と入ります。",
  );
  assert.equal(summarizePriorReceipts(undefined, "2026-11-24").issuedBefore, false);
});

test("1 回発行した注文: 日付と時刻で理由を 1 文", () => {
  const s = summarizePriorReceipts(
    [{ id: "a", createdAt: "2026-11-20T05:04:00.000Z", localDate: "2026-11-20", transactionTime: "14:04" }],
    "2026-11-24",
  );
  assert.equal(s.issuedBefore, true);
  assert.equal(s.count, 1);
  assert.equal(s.notice, "この注文は 11/20 14:04 に領収書を発行しています。");
  assert.match(reissueHelpText(s, true), /再発行にしています/);
  assert.match(reissueHelpText(s, false), /外しています/);
});

test("何回か発行した注文: 回数といちばん新しい日（並びが逆でも）", () => {
  const s = summarizePriorReceipts(
    [
      { id: "old", createdAt: "2026-11-20T05:04:00.000Z", localDate: "2026-11-20", transactionTime: "14:04" },
      { id: "new", createdAt: "2026-11-24T01:00:00.000Z", localDate: "2026-11-24", transactionTime: "10:00" },
    ],
    "2026-11-24",
  );
  assert.equal(s.count, 2);
  assert.equal(s.lastLabel, "今日 10:00");
  assert.equal(s.notice, "この注文は領収書を 2 回発行しています（いちばん新しいのは 今日 10:00）。");
});

test("時刻が無くても文になる", () => {
  const s = summarizePriorReceipts([{ id: "a", createdAt: "x" }], "2026-11-24");
  assert.equal(s.issuedBefore, true);
  assert.equal(s.notice, "この注文は前に領収書を発行しています。");
});

test("管理画面: 前に発行があるのに再発行を外したものだけ印が付く", () => {
  const issues = [
    { id: "r1", orderId: "100", isReissue: false, createdAt: new Date("2026-11-20T05:00:00Z") }, // 初めて
    { id: "r2", orderId: "100", isReissue: true, createdAt: new Date("2026-11-21T05:00:00Z") }, // 再発行
    { id: "r3", orderId: "100", isReissue: false, createdAt: new Date("2026-11-22T05:00:00Z") }, // 外して発行
    { id: "r4", orderId: "200", isReissue: false, createdAt: new Date("2026-11-22T06:00:00Z") }, // 別の注文の初めて
  ];
  const got = receiptIdsIssuedWithoutReissue(issues, issues);
  assert.deepEqual([...got], ["r3"]);
});

test("管理画面: 1 ページに初めての発行が入っていなくても、前の記録から読める", () => {
  const page = [{ id: "r3", orderId: "100", isReissue: false, createdAt: "2026-11-22T05:00:00Z" }];
  const earlier = [
    { id: "r1", orderId: "100", createdAt: "2026-11-20T05:00:00Z" },
    { id: "r3", orderId: "100", createdAt: "2026-11-22T05:00:00Z" },
  ];
  assert.deepEqual([...receiptIdsIssuedWithoutReissue(page, earlier)], ["r3"]);
  // 自分しか無ければ初めての発行
  assert.equal(receiptIdsIssuedWithoutReissue(page, [earlier[1]]).size, 0);
});

test("管理画面: 同じ時刻の 2 件は 1 件だけを初めてとする", () => {
  const t = "2026-11-22T05:00:00Z";
  const rows = [
    { id: "a", orderId: "1", isReissue: false, createdAt: t },
    { id: "b", orderId: "1", isReissue: false, createdAt: t },
  ];
  assert.deepEqual([...receiptIdsIssuedWithoutReissue(rows, rows)], ["b"]);
});
