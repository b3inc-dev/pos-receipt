/**
 * Shopify ロケーション ID の表記ゆれをそろえる共通処理。
 *
 * POS・DB・Shopify API からは、同じロケーションが
 * "gid://shopify/Location/123" / "123" / "…/Location/123" のように届く。
 * ここで一つの形にそろえる（以前は各ルートに同じ関数が写されていた）。
 */

export const LOCATION_GID_PREFIX = "gid://shopify/Location/";

/**
 * GID にそろえる。GID / 数値だけ / 末尾が "/数値" の文字列を受け付ける。
 * 空・数値を取り出せない値は null。
 */
export function normalizeLocationGid(locationId: string | null | undefined): string | null {
  const s = String(locationId ?? "").trim();
  if (!s) return null;
  if (s.startsWith(LOCATION_GID_PREFIX)) return s;
  if (/^\d+$/.test(s)) return `${LOCATION_GID_PREFIX}${s}`;
  const m = s.match(/\/(\d+)$/);
  return m?.[1] ? `${LOCATION_GID_PREFIX}${m[1]}` : null;
}

/**
 * GID / 数値だけのときは GID にそろえ、それ以外は前後の空白を落とした元の値を返す。
 * DB の shopifyLocationGid と突き合わせるとき、知らない形を null にしたくない呼び出し元向け
 * （api.settlements.create の印字モード解決が以前からこの動き）。
 */
export function normalizeLocationGidOrRaw(locationId: string | null | undefined): string {
  const s = String(locationId ?? "").trim();
  if (s.startsWith(LOCATION_GID_PREFIX)) return s;
  if (/^\d+$/.test(s)) return `${LOCATION_GID_PREFIX}${s}`;
  return s;
}

/** 数値の ID だけを取り出す。取り出せないときは null。 */
export function extractLocationNumericId(locationId: string | null | undefined): string | null {
  const gid = normalizeLocationGid(locationId);
  if (!gid) return null;
  return gid.slice(LOCATION_GID_PREFIX.length);
}
