/**
 * POS セッションの「現在ログインしているロケーション」を取得するヘルパー
 * Session API: https://shopify.dev/docs/api/pos-ui-extensions/2024-04/apis/session-api
 *
 * - locationId: 数値（POS の currentSession.locationId）
 * - locationGid: "gid://shopify/Location/{id}" 形式
 * - locationIdParam: 文字列（注文検索の location_id 等にそのまま渡せる）
 * - isReady: セッション判定が完了したか（ポーリング終了 or 値取得済み）
 *
 * POS Stock の useSessionLocationId / useOriginLocationGid と同等の設計。
 * currentSession.locationId は数値・文字列・GID 形式のいずれかで返る可能性があるため
 * 全パターンに対応した正規化を行う。
 */
import { useState, useEffect, useMemo } from "preact/hooks";

/**
 * あらゆる形式の locationId を正規化する
 * @param {unknown} raw
 * @returns {{ locationId: number | null, locationGid: string | null, locationIdParam: string | null }}
 */
function normalizeLocationId(raw) {
  if (raw == null) {
    return { locationId: null, locationGid: null, locationIdParam: null };
  }
  const s = String(raw).trim();

  // GID 形式: "gid://shopify/Location/12345"
  if (s.startsWith("gid://shopify/Location/")) {
    const numId = s.slice("gid://shopify/Location/".length);
    return {
      locationId: Number(numId) || null,
      locationGid: s,
      locationIdParam: numId,
    };
  }

  // 純粋な数値文字列: "12345"
  if (/^\d+$/.test(s)) {
    return {
      locationId: Number(s),
      locationGid: `gid://shopify/Location/${s}`,
      locationIdParam: s,
    };
  }

  // URL 内に Location/数字 が含まれるパターン
  const m = s.match(/Location\/(\d+)/);
  if (m?.[1]) {
    return {
      locationId: Number(m[1]),
      locationGid: `gid://shopify/Location/${m[1]}`,
      locationIdParam: m[1],
    };
  }

  return { locationId: null, locationGid: null, locationIdParam: null };
}

/**
 * 1回だけ同期的にセッションのロケーションを取得する（コールバック内での利用向け）
 * ※ コンポーネント初期化時は useSessionLocation() を使うこと
 */
export function getSessionLocation() {
  return normalizeLocationId(
    globalThis?.shopify?.session?.currentSession?.locationId
  );
}

/**
 * POS セッションのロケーションをリアクティブに取得する React/Preact フック
 * POS Stock の useSessionLocationId + useOriginLocationGid と同等のポーリング設計。
 *
 * - セッションが即座に確定している場合: マウント直後に正しい値を返す
 * - セッションが遅延している場合: 100ms 間隔でポーリングし確定したら再レンダリング
 * - 50 ティック（5秒）以内に確定しない場合は null のまま isReady=true にする
 *
 * @returns {{ locationId: number | null, locationGid: string | null, locationIdParam: string | null, isReady: boolean }}
 */
export function useSessionLocation() {
  const [state, setState] = useState(() => {
    const raw = globalThis?.shopify?.session?.currentSession?.locationId ?? null;
    return { raw, isReady: raw !== null };
  });

  useEffect(() => {
    if (state.isReady) return; // すでに確定済み

    let alive = true;
    let ticks = 0;

    const iv = setInterval(() => {
      if (!alive) return;

      const next =
        globalThis?.shopify?.session?.currentSession?.locationId ?? null;
      ticks++;

      if (next !== null || ticks >= 50) {
        // 値が取れたか、5秒経過 → 確定
        setState({ raw: next, isReady: true });
        clearInterval(iv);
      }
    }, 100);

    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [state.isReady]);

  return useMemo(
    () => ({ ...normalizeLocationId(state.raw), isReady: state.isReady }),
    [state]
  );
}
