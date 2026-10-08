/**
 * Shopify Printing API ヘルパー（POS UI Extensions 2026-07+）
 * shopify.printing.getPrinters / print
 */
import { getAppUrl } from "./appUrl.js";
import { toUserMessage } from "./errorMessage.js";

/**
 * @param {string} relativePath 例: /api/print/sales/123
 * @returns {string} Printing API 用の同一オリジン相対パス（または絶対 URL）
 */
export function printSrc(relativePath) {
  const path = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  // 公式: 相対パスは application_url に付与。絶対は同一オリジン必須。
  // 開発トンネルでは絶対 URL の方が確実なことがある。
  try {
    const base = getAppUrl();
    if (base && typeof base === "string") {
      return `${base.replace(/\/$/, "")}${path}`;
    }
  } catch (_) {}
  return path;
}

/**
 * @returns {Promise<{ ok: boolean, printer?: object, error?: string, usedDialog?: boolean }>}
 */
export async function printHtml(relativeOrAbsoluteSrc) {
  const src =
    relativeOrAbsoluteSrc.startsWith("http") || relativeOrAbsoluteSrc.startsWith("/")
      ? relativeOrAbsoluteSrc.startsWith("http")
        ? relativeOrAbsoluteSrc
        : printSrc(relativeOrAbsoluteSrc)
      : printSrc(relativeOrAbsoluteSrc);

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
      printer = list.find((p) => p?.connected) ?? list[0] ?? null;
    }

    if (printer) {
      await printing.print(src, { printer });
      return { ok: true, printer };
    }

    // 未接続時はダイアログ fallback（printer 省略）
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
