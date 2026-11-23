/**
 * Shopify Printing API ヘルパー（POS UI Extensions 2026-07+）
 * shopify.printing.getPrinters / print
 *
 * print src は相対パスのみ渡す。Shopify が application_url を付与する。
 * getAppUrl() 絶対 URL は使わない（公開アプリ／DEV トンネルでオリジン不一致になり得る）。
 *
 * 直接印字は connected: true の機種のみ。未接続を成功扱いしない。
 * print() の解決は API 受付であり、紙の排出完了ではない。
 * タイムアウト後は成否不明として扱い、自動再送しない。
 */
import { getAppUrl } from "./appUrl.js";
import { toUserMessage } from "./errorMessage.js";
import {
  PRINT_OUTCOME,
  PRINT_TIMEOUT_MS,
  classifyPrinters,
  mapPrinterErrorMessage,
  pickDirectPrinter,
  printResultMessage,
  withTimeout,
} from "./printApiCore.js";

export {
  PRINT_OUTCOME,
  PRINT_TIMEOUT_MS,
  classifyPrinters,
  pickDirectPrinter,
  printResultMessage,
} from "./printApiCore.js";

const inFlightSrc = new Set();

/**
 * @param {string} relativePath 例: /api/print/sales/123
 * @returns {string} Printing API 用の同一オリジン相対パス
 */
export function printSrc(relativePath) {
  const path = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  return path;
}

function toRelativeSrc(relativeOrAbsoluteSrc) {
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
  return src;
}

/**
 * @param {string} relativeOrAbsoluteSrc
 * @param {{ allowDialog?: boolean }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   outcome: string,
 *   printer?: object,
 *   error?: string,
 *   usedDialog?: boolean,
 *   canUseDialog?: boolean,
 *   paperConfirmed?: boolean,
 *   extraConnected?: number,
 *   disconnectedCount?: number,
 * }>}
 */
export async function printHtml(relativeOrAbsoluteSrc, options = {}) {
  const allowDialog = !!options.allowDialog;
  const src = toRelativeSrc(relativeOrAbsoluteSrc);

  const printing = globalThis?.shopify?.printing;
  if (!printing?.print) {
    return {
      ok: false,
      outcome: PRINT_OUTCOME.UNAVAILABLE,
      paperConfirmed: false,
      error:
        "この POS では印刷できません。Shopify POS を新しい版に更新してください。",
    };
  }

  if (inFlightSrc.has(src)) {
    return {
      ok: false,
      outcome: PRINT_OUTCOME.IN_FLIGHT,
      paperConfirmed: false,
      error: "印刷中です。終わるまでお待ちください。",
    };
  }
  inFlightSrc.add(src);

  try {
    let classified = {
      connected: [],
      disconnected: [],
      connectedCount: 0,
      disconnectedCount: 0,
      totalCount: 0,
    };
    if (typeof printing.getPrinters === "function") {
      try {
        const printers = await withTimeout(printing.getPrinters(), PRINT_TIMEOUT_MS);
        classified = classifyPrinters(printers);
      } catch {
        return {
          ok: false,
          outcome: PRINT_OUTCOME.FAILED,
          paperConfirmed: false,
          error: "プリンタを見つけられませんでした。まだ印刷していません。プリンタのつながりを確かめて、もう一度お試しください。",
        };
      }
    }

    const printer = pickDirectPrinter({ printers: classified.connected });
    if (!printer) {
      if (!allowDialog) {
        return {
          ok: false,
          outcome: PRINT_OUTCOME.NO_CONNECTED_PRINTER,
          canUseDialog: true,
          usedDialog: false,
          paperConfirmed: false,
          disconnectedCount: classified.disconnectedCount,
          error:
            classified.disconnectedCount > 0
              ? "つながっているプリンタがありません。用紙・電源・つながりを確かめてください。"
              : "つながっているレシートプリンタがありません。POS の設定でプリンタをつないでください。",
        };
      }
      await withTimeout(printing.print(src), PRINT_TIMEOUT_MS);
      return {
        ok: true,
        outcome: PRINT_OUTCOME.DIALOG_PRESENTED,
        usedDialog: true,
        paperConfirmed: false,
      };
    }

    await withTimeout(printing.print(src, { printer }), PRINT_TIMEOUT_MS);
    return {
      ok: true,
      outcome: PRINT_OUTCOME.DIRECT_ACCEPTED,
      printer,
      usedDialog: false,
      paperConfirmed: false,
      extraConnected: Math.max(0, classified.connectedCount - 1),
    };
  } catch (e) {
    if (e?.name === "PrintTimeoutError" || e?.code === "PRINT_TIMEOUT") {
      return {
        ok: false,
        outcome: PRINT_OUTCOME.TIMEOUT_UNKNOWN,
        paperConfirmed: false,
        error: mapPrinterErrorMessage(e?.message),
      };
    }
    return {
      ok: false,
      outcome: PRINT_OUTCOME.FAILED,
      paperConfirmed: false,
      error: toUserMessage(mapPrinterErrorMessage(e?.message || String(e))),
    };
  } finally {
    inFlightSrc.delete(src);
  }
}

/**
 * 印刷を受け付けたことをサーバーに残す（次からの印刷を「再印字」と見分けるため）。
 * 失敗しても印刷の結果は変えない（印が付かないだけ）。精算は markSettlementPrinted を使う。
 * @param {"receipt"|"sales"|"gift"} kind
 */
export async function markReceiptPrinted(kind, id) {
  try {
    const session = globalThis?.shopify?.session;
    const token = session?.getSessionToken ? await session.getSessionToken() : null;
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    await fetch(`${getAppUrl()}/api/print/printed`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind, id: String(id ?? "") }),
    });
  } catch (_) {
    /* 記録できなくても印刷は終わっている */
  }
}

export async function printSalesReceipt(orderId, options = {}) {
  const id = String(orderId || "").replace("gid://shopify/Order/", "");
  const suffix = options.gift ? "?copy=gift" : "";
  const res = await printHtml(`/api/print/sales/${encodeURIComponent(id)}${suffix}`, options);
  if (res?.ok) await markReceiptPrinted(options.gift ? "gift" : "sales", id);
  return res;
}

export async function printSettlementReceipt(settlementId, options = {}) {
  return printHtml(`/api/print/settlement/${encodeURIComponent(settlementId)}`, options);
}

/** 領収書（関数名は昔のまま）。印刷を受け付けたら記録を残す */
export async function printGiftReceipt(receiptIssueId, options = {}) {
  const res = await printHtml(`/api/print/receipt/${encodeURIComponent(receiptIssueId)}`, options);
  if (res?.ok) await markReceiptPrinted("receipt", receiptIssueId);
  return res;
}

/**
 * POS 向け。旧フラグが DB に残っていても Printing API を無効化しない。
 */
export async function getPrintSettings() {
  const unified = {
    preferPrintingApi: true,
    settlementPrintingApiEnabled: true,
    receiptPrintingApiEnabled: true,
    unifiedPrintMode: "shopify_printing",
    allowReprintSettlement: true,
  };
  try {
    const session = globalThis?.shopify?.session;
    const token = session?.getSessionToken ? await session.getSessionToken() : null;
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${getAppUrl()}/api/settings/print`, { headers });
    if (!res.ok) return unified;
    const j = await res.json();
    return {
      ...unified,
      allowReprintSettlement: j?.allowReprintSettlement !== false,
    };
  } catch (_) {
    return unified;
  }
}
