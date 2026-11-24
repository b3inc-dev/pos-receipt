/**
 * ciara-system とのつながり（予算の取り込み・入店数の読み込み）の画面の表示を決める。
 * 定期の仕事が動いているときだけ「つながっています」にする（前に成功していても、
 * 始めている途中・止まっているときは出さない。#126 の見直し）。
 */
import type { CiaraSchedulerState } from "../services/ciaraSyncScheduler.server";

export type CiaraConnectionTexts = {
  /** 例:「1 時間ごとの取り込み」 */
  job: string;
  /** 動いていて前回が成功のとき */
  running: string;
  /** オフのとき */
  turnOn: string;
  /** サーバーの準備がまだのとき */
  notReady: string;
  /** 動いているが、まだ一度も読んでいないとき */
  tryNow: string;
};

export type CiaraConnectionView = {
  connected: boolean;
  stopped: boolean;
  badge: { tone: "success" | "attention" | "critical"; label: string };
  note: string;
};

export function ciaraConnectionView(input: {
  hasSecret: boolean;
  enabled: boolean;
  last: { ok: boolean; message: string } | null | undefined;
  scheduler: { state: CiaraSchedulerState; hadFailure?: boolean };
  texts: CiaraConnectionTexts;
}): CiaraConnectionView {
  const { hasSecret, enabled, last, scheduler, texts } = input;
  const waiting = { tone: "attention" as const, label: "まだです" };
  if (!enabled) return { connected: false, stopped: false, badge: waiting, note: texts.turnOn };
  if (!hasSecret) return { connected: false, stopped: false, badge: waiting, note: texts.notReady };

  const stopped = scheduler.state === "failed" || (scheduler.state !== "running" && Boolean(scheduler.hadFailure));
  if (stopped) {
    return {
      connected: false,
      stopped: true,
      badge: { tone: "critical", label: "止まっています" },
      note:
        scheduler.state === "failed"
          ? `${texts.job}が止まっています。5 分ほどで自動でもう一度始めます。続くときは連絡してください。`
          : `${texts.job}が止まっていたので、もう一度始めています。少しして再読み込みしてください。続くときは連絡してください。`,
    };
  }
  if (scheduler.state !== "running") {
    return { connected: false, stopped: false, badge: waiting, note: `${texts.job}を始めています。少しして再読み込みしてください。` };
  }
  if (last?.ok) return { connected: true, stopped: false, badge: { tone: "success", label: "つながっています" }, note: texts.running };
  return { connected: false, stopped: false, badge: waiting, note: last ? last.message : texts.tryNow };
}
