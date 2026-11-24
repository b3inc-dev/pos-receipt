/**
 * ciara-system の読む口の URL（Ciara のカスタムアプリだけ）。
 * 送り先のホストはサーバーの環境変数 CIARA_SYSTEM_ORIGIN（例 https://ciara.example.com）で決め、管理画面からは変えられない
 * （合言葉を管理画面に入れた好きな URL へ送らないため。見直し #123 P2）。https だけ。未設定なら null（止まっている）。
 */
export const CIARA_BUDGETS_PATH = "/api/external/pos-receipt/budgets";
export const CIARA_VISITS_PATH = "/api/external/pos-receipt/visits";

export function ciaraSystemUrl(path: string): URL | null {
  const raw = process.env.CIARA_SYSTEM_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const origin = new URL(raw);
    if (origin.protocol !== "https:") return null;
    return new URL(path, origin.origin);
  } catch {
    return null;
  }
}
