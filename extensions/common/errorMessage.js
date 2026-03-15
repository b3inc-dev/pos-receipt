/**
 * API エラー文言をユーザー向け日本語に揃える。
 * 「Load failed」等は履歴の有無ではなく読み込み失敗のエラーなので、その旨が分かる文言に変換する。
 */

const FALLBACK = "読み込みに失敗しました。接続先と認証を確認してください。";

const MAP = {
  "load failed": FALLBACK,
  "load failed.": FALLBACK,
  "failed to load": FALLBACK,
  "failed to fetch": "サーバーに接続できません。ネットワークとURLを確認してください。",
  "network error": "ネットワークエラーです。接続を確認してください。",
  "network request failed": "ネットワークエラーです。接続を確認してください。",
  "401": "認証に失敗しました。アプリの再読み込みを試してください。",
  "403": "アクセスが拒否されました。",
  "404": "見つかりません。",
  "500": "サーバーエラーです。しばらくしてから再試行してください。",
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
  if (t.includes("load failed")) return FALLBACK;
  if (t.includes("failed to fetch")) return MAP["failed to fetch"];
  if (t.includes("network")) return MAP["network error"];
  if (t.includes("unauthorized") || t === "401") return MAP["401"];
  return msg;
}
