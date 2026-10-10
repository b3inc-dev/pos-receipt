/**
 * Shopify Printing API ヘルパー（POS UI Extensions 2026-07+）
 * shopify.printing.getPrinters / print
 *
 * print src は相対パスのみ渡す。Shopify が application_url を付与する。
 * getAppUrl() 絶対 URL は使わない（公開アプリ／DEV トンネルでオリジン不一致になり得る）。
 */
import { getAppUrl } from "./appUrl.js";
import { toUserMessage } from "./errorMessage.js";

/**
 * @param {string} relativePath 例: /api/print/sales/123
 * @returns {string} Printing API 用の同一オリジン相対パス
 */
export function printSrc(relativePath) {
  const path = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  return path;
}

/**
 * @returns {Promise<{ ok: boolean, printer?: object, error?: string, usedDialog?: boolean }>}
 */
export async function printHtml(relativeOrAbsoluteSrc) {
  // 絶対 URL が渡ってきた場合もパス部分だけ使う（誤用防止）
  let src = relativeOrAbsoluteSrc;
  if (typeof src === "string" && /^https?:\/\//i.test(src)) {
    try {
      src = new URL(src).pathname + new URL(src).search;
    } catch (_) {
      src = printSrc(String(relativeOrAbsoluteSrc).replace(/^https?:\/\/[^/]+/i, "") || "/");
    }
  } else {
    src = printSrc(String(relativeOrAbsoluteSrc || "/"));
  }

  const printing = globalThis?.shopify?.printing;
  if (!printing?.print) {
    return {
      ok: false,
      error:
        "この POS では Printing API を利用できません。api_version 2026-07+ と POS 11.11+ が必要です。",
    };
  }

  try {
    let printer = null;
    if (typeof printing.getPrinters === "function") {
      const printers = await printing.getPrinters();
      const list = Array.isArray(printers) ? printers : printers?.printers ?? [];
      // connected のみ。未接続の list[0] は渡さない（公式: printer 省略＝ダイアログ）
      printer = list.find((p) => p?.connected) ?? null;
    }

    if (printer) {
      await printing.print(src, { printer });
      return { ok: true, printer };
    }

    // 接続プリンタ無し: printer 省略でダイアログ
    await printing.print(src);
    return { ok: true, usedDialog: true };
  } catch (e) {
    return { ok: false, error: toUserMessage(e?.message || String(e)) };
  }
}

export async function printSalesReceipt(orderId) {
  const id = String(orderId || "").replace("gid://shopify/Order/", "");
  return printHtml(`/api/print/sales/${encodeURIComponent(id)}`);
}

export async function printSettlementReceipt(settlementId) {
  return printHtml(`/api/print/settlement/${encodeURIComponent(settlementId)}`);
}

export async function printGiftReceipt(receiptIssueId) {
  return printHtml(`/api/print/receipt/${encodeURIComponent(receiptIssueId)}`);
}

/**
 * Admin 印字設定（Printing API フラグ）を POS から取得。
 * 失敗時は安全側（旧導線 primary / Printing API 非表示）を返す。
 */
export async function getPrintSettings() {
  const defaults = {
    preferPrintingApi: false,
    settlementPrintingApiEnabled: false,
    receiptPrintingApiEnabled: false,
  };
  try {
    const session = globalThis?.shopify?.session;
    const token = session?.getSessionToken ? await session.getSessionToken() : null;
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${getAppUrl()}/api/settings/print`, { headers });
    if (!res.ok) return defaults;
    const j = await res.json();
    return {
      preferPrintingApi: !!j?.preferPrintingApi,
      settlementPrintingApiEnabled: !!j?.settlementPrintingApiEnabled,
      receiptPrintingApiEnabled: !!j?.receiptPrintingApiEnabled,
    };
  } catch (_) {
    return defaults;
  }
}
