/**
 * POS セッションの「現在ログインしているロケーション」を取得するヘルパー
 * Session API: https://shopify.dev/docs/api/pos-ui-extensions/2024-04/apis/session-api
 *
 * - locationId: 数値（POS の currentSession.locationId）
 * - locationGid: "gid://shopify/Location/{id}" 形式（売上サマリー等の API 用）
 * - locationIdParam: 文字列（注文検索の location_id 等にそのまま渡せる）
 */

/**
 * 現在の POS セッションのロケーション ID を取得する
 * @returns {{ locationId: number | null, locationGid: string | null, locationIdParam: string | null }}
 */
export function getSessionLocation() {
  const session = globalThis?.shopify?.session?.currentSession;
  const raw = session?.locationId;
  if (raw == null || typeof raw !== "number") {
    return { locationId: null, locationGid: null, locationIdParam: null };
  }
  const id = Number(raw);
  if (Number.isNaN(id)) {
    return { locationId: null, locationGid: null, locationIdParam: null };
  }
  return {
    locationId: id,
    locationGid: `gid://shopify/Location/${id}`,
    locationIdParam: String(id),
  };
}
