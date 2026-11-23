/**
 * shopify.printing の純関数（テスト可能）。
 * POS 実機の紙排出完了は API では取れない。
 */

export const PRINT_TIMEOUT_MS = 20_000;

export const PRINT_OUTCOME = {
  DIRECT_ACCEPTED: "direct_accepted",
  DIALOG_PRESENTED: "dialog_presented",
  NO_CONNECTED_PRINTER: "no_connected_printer",
  TIMEOUT_UNKNOWN: "timeout_unknown",
  IN_FLIGHT: "in_flight",
  UNAVAILABLE: "unavailable",
  FAILED: "failed",
};

export function normalizePrinterList(printers) {
  if (Array.isArray(printers)) return printers.filter(Boolean);
  if (printers && Array.isArray(printers.printers)) return printers.printers.filter(Boolean);
  return [];
}

export function classifyPrinters(printers) {
  const list = normalizePrinterList(printers);
  const connected = list.filter((p) => p?.connected === true);
  const disconnected = list.filter((p) => p?.connected !== true);
  return {
    connected,
    disconnected,
    connectedCount: connected.length,
    disconnectedCount: disconnected.length,
    totalCount: list.length,
  };
}

/** connected: true の機種だけを直接印字に使う。未接続の list[0] は使わない。 */
export function pickDirectPrinter(printers) {
  return classifyPrinters(printers).connected[0] ?? null;
}

export function mapPrinterErrorMessage(raw) {
  const msg = String(raw || "");
  const lower = msg.toLowerCase();
  if (/paper|用紙/.test(lower) || /out of paper|paper.?out/.test(lower)) {
    return "プリンタの用紙が切れているかもしれません。用紙を入れてから、もう一度印刷してください。";
  }
  if (/disconnect|offline|not connected|切断|未接続/.test(lower)) {
    return "プリンタがつながっていません。電源とつながりを確かめてください。";
  }
  if (/timeout|timed out/.test(lower)) {
    return "印刷できたか分かりませんでした。紙が出ていなければ、もう一度印刷してください。";
  }
  return msg || "印刷できませんでした";
}

export function printResultMessage(res) {
  if (!res) return "印刷できませんでした";
  const extra =
    res.extraConnected > 0
      ? `プリンタが ${res.extraConnected + 1} 台つながっているため、1 台目に送りました。`
      : "";
  switch (res.outcome) {
    case PRINT_OUTCOME.DIRECT_ACCEPTED:
      return `${extra}プリンタに送りました。紙が出たか確かめてください。`.trim();
    case PRINT_OUTCOME.DIALOG_PRESENTED:
      return "印刷の画面を開きました。そこでプリンタを選んで印刷してください。";
    case PRINT_OUTCOME.NO_CONNECTED_PRINTER:
      return (
        res.error ||
        "つながっているレシートプリンタがありません。プリンタの電源とつながりを確かめてください。"
      );
    case PRINT_OUTCOME.TIMEOUT_UNKNOWN:
      return (
        res.error ||
        "印刷できたか分かりませんでした。紙が出ていなければ、もう一度印刷してください。"
      );
    case PRINT_OUTCOME.IN_FLIGHT:
      return res.error || "印刷中です。終わるまでお待ちください。";
    case PRINT_OUTCOME.UNAVAILABLE:
      return (
        res.error ||
        "この POS では印刷できません。Shopify POS を新しい版に更新してください。"
      );
    default:
      return res.error || "印刷できませんでした";
  }
}

export function withTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(
        timeoutMessage ||
          "印刷できたか分かりませんでした。紙が出ていなければ、もう一度印刷してください。",
      );
      err.name = "PrintTimeoutError";
      err.code = "PRINT_TIMEOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
