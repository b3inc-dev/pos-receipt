/**
 * API エラー文言をユーザー向け日本語に揃える。
 * 「Load failed」等は履歴の有無ではなく読み込み失敗のエラーなので、その旨が分かる文言に変換する。
 */

/*
 * 店の人が読む文なので、技術の言葉（接続先・認証・URL など）を出さず、取れる行動で書く。
 * 前の文「読み込みに失敗しました。接続先と認証を確認してください。」で調べるときは
 * docs/POS_READ_FAILED_CONNECTION_AUTH.md を見る（原因は同じ: Load failed 等）。
 */
const CONTACT = "直らないときは、管理者に連絡してください。";
const LOAD_FAILED = `読み込めませんでした。通信を確かめて、もう一度読み込んでください。${CONTACT}`;
/** 理由がわからないとき（読み込み・保存のどちらでも出るので「読み込み」と言い切らない） */
const FALLBACK = `うまくいきませんでした。通信を確かめて、もう一度お試しください。${CONTACT}`;
const NETWORK = `通信がつながりませんでした。通信を確かめて、もう一度お試しください。${CONTACT}`;
const BUSY = "混雑しています。しばらくしてからお試しください。";

const MAP = {
  "load failed": LOAD_FAILED,
  "load failed.": LOAD_FAILED,
  "failed to load": LOAD_FAILED,
  "failed to fetch": NETWORK,
  "network error": NETWORK,
  "network request failed": NETWORK,
  "401": `ログインの確かめに失敗しました。この画面を閉じて、開き直してください。${CONTACT}`,
  "403": "この操作はできません。管理者に連絡してください。",
  "404": "見つかりませんでした。もう一度読み込んでください。",
  "500": `うまく処理できませんでした。しばらくしてから、もう一度お試しください。${CONTACT}`,
  "503": BUSY,
  throttled: BUSY,
  [BUSY]: BUSY,
};

/**
 * サーバーや環境から返る汎用英語メッセージを、ユーザー向け日本語に変換する。
 * @param {string} [msg] - 元のエラーメッセージ
 * @returns {string}
 */
export function toUserMessage(msg) {
  if (msg == null || typeof msg !== "string") return FALLBACK;
  const t = msg.trim().toLowerCase();
  if (!t) return FALLBACK;
  if (MAP[t]) return MAP[t];
  if (t.startsWith("http ")) {
    const code = t.replace(/^http\s+/, "").split(/\s/)[0];
    if (MAP[code]) return MAP[code];
  }
  if (t.includes("load failed")) return LOAD_FAILED;
  if (t.includes("failed to fetch")) return MAP["failed to fetch"];
  if (t.includes("network")) return MAP["network error"];
  if (t.includes("unauthorized") || t === "401") return MAP["401"];
  if (t.includes("throttled") || t.includes("混雑しています")) return MAP.throttled;
  // 日本語を含まない文は、サーバーの中の英語のエラー（データベースの文など）なので店の人には見せない。
  // 例: 「Invalid `prisma.specialRefundEvent.findMany()` invocation: The column ... does not exist」
  // (2026-11-23 開発ストアの精算画面でそのまま赤字で出た)。調べるときはサーバーのログを見る。
  if (!JAPANESE_CHAR.test(msg)) return FALLBACK;
  return msg;
}

/** ひらがな・カタカナ・漢字のどれかがあれば、店の人向けに書いた文とみなす */
const JAPANESE_CHAR = /[\u3040-\u30ff\u3400-\u9fff]/;

/**
 * エラーに HTTP の番号を付ける（画面の文には出さない。調べるときに err.status で見る）。
 * @param {Error} err
 * @param {number} [status]
 * @returns {Error}
 */
export function withStatus(err, status) {
  if (status) {
    try {
      err.status = status;
    } catch (_) {}
  }
  return err;
}
