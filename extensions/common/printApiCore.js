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
    return "プリンタの用紙切れの可能性があります。用紙をセットしてから再印刷してください。";
  }
  if (/disconnect|offline|not connected|切断|未接続/.test(lower)) {
    return "プリンタが切断またはオフラインです。接続を確認してください。";
  }
  if (/timeout|timed out/.test(lower)) {
    return "印字の成否を確認できませんでした。自動では再送しません。紙が出ていなければ再印刷してください。";
  }
  return msg || "印字に失敗しました";
}

export function printResultMessage(res) {
  if (!res) return "印字に失敗しました";
  const extra =
    res.extraConnected > 0
      ? `接続中プリンタが ${res.extraConnected + 1} 台あるため、先頭の接続機へ送りました。`
      : "";
  switch (res.outcome) {
    case PRINT_OUTCOME.DIRECT_ACCEPTED:
      return `${extra}プリンタへ送信しました。紙の排出完了は未確認です。`.trim();
    case PRINT_OUTCOME.DIALOG_PRESENTED:
      return "システム印刷ダイアログを開きました（直接印字の成功ではありません）。";
    case PRINT_OUTCOME.NO_CONNECTED_PRINTER:
      return (
        res.error ||
        "接続中のレシートプリンタがありません。未接続のまま成功扱いはしません。"
      );
    case PRINT_OUTCOME.TIMEOUT_UNKNOWN:
      return (
        res.error ||
        "印字の成否を確認できませんでした。自動では再送しません。紙が出ていなければ再印刷してください。"
      );
    case PRINT_OUTCOME.IN_FLIGHT:
      return res.error || "印字処理中です。完了するまで再タップしないでください。";
    case PRINT_OUTCOME.UNAVAILABLE:
      return (
        res.error ||
        "この POS では Printing API を利用できません。api_version 2026-07+ と POS 11.11+ が必要です。"
      );
    default:
      return res.error || "印字に失敗しました";
  }
}

export function withTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(
        timeoutMessage ||
          "印字の成否を確認できませんでした。自動では再送しません。紙が出ていなければ再印刷してください。",
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
