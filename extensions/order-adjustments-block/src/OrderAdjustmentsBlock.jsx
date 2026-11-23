/**
 * 注文ページ（Shopify 管理画面）のブロック: この注文の特殊返金・商品券調整
 * - 記録はアプリが注文メタフィールド pos.adjustments に書く（docs/ORDER_ADJUSTMENTS_METAFIELD.md）
 * - ここは読むだけ。「変更」でアプリの注文ごとの記録の画面を開く（前の行は無効にして残す）
 */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

export default async () => {
  render(<OrderAdjustmentsBlock />, document.body);
};

const KIND_LABELS = {
  cash_refund: "現金返金",
  payment_method_override: "返金手段の付け替え",
  receipt_cash_adjustment: "レシート現金調整",
  voucher_change_adjustment: "商品券",
};

const STATUS_LABELS = {
  pending_approval: "承認待ち",
  rejected: "却下",
  voided: "無効",
};

function yen(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return "—";
  return `¥${n.toLocaleString("ja-JP")}`;
}

function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  return m ? `${Number(m[2])}/${Number(m[3])}` : "";
}

function entryText(e) {
  const kind = KIND_LABELS[e.kind] ?? e.kind;
  if (e.type === "voucher") {
    const face = e.voucher?.face != null ? `額面 ${yen(e.voucher.face)}` : "";
    const change = e.voucher?.change != null ? `お釣り ${yen(e.voucher.change)}` : "";
    return [kind, face, change].filter(Boolean).join(" ");
  }
  const from = e.fromLabel ?? e.fromMethod ?? "";
  const to = e.toLabel ?? e.toMethod ?? "";
  const methods = from || to ? `${from || "—"}→${to || "—"}` : "";
  const adjust = e.adjustKind === "undo" ? "（返金を取り消す）" : e.adjustKind === "extra" ? "（現金を足す）" : "";
  return [kind + adjust, methods, yen(e.amount)].filter(Boolean).join(" ");
}

const STATE_NOTICES = {
  differs: "注文の記録がアプリの記録と違います。Shopify の画面で書き換えられた可能性があります。",
  missing: "注文にまだ書けていません。アプリの画面で「書き直す」を押してください。",
  invalid: "注文の記録の形が読めません。アプリの画面で「書き直す」を押してください。",
  unreadable: "注文の記録を読めませんでした。開き直してください。",
};

function OrderAdjustmentsBlock() {
  const orderId = shopify.data?.selected?.[0]?.id ?? "";
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    if (!orderId) {
      setState({ loading: false, error: "注文が分かりません。", data: null });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // アプリの URL への fetch には、管理画面が認証のヘッダーを付ける
        const res = await fetch(`/api/admin/order-adjustments?orderId=${encodeURIComponent(orderId)}`);
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !json.ok) {
          setState({ loading: false, error: json.error ?? "読み込めませんでした。", data: null });
          return;
        }
        setState({ loading: false, error: null, data: json });
      } catch {
        if (!cancelled) setState({ loading: false, error: "読み込めませんでした。開き直してください。", data: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  const editHref = `app:/app/order-adjustments?orderId=${encodeURIComponent(orderId)}`;

  if (state.loading) {
    return (
      <s-admin-block heading="返金・商品券釣銭調整">
        <s-text color="subdued">読み込み中…</s-text>
      </s-admin-block>
    );
  }
  if (state.error) {
    return (
      <s-admin-block heading="返金・商品券釣銭調整">
        <s-banner tone="critical">{state.error}</s-banner>
      </s-admin-block>
    );
  }

  const entries = state.data?.entries ?? [];
  const shown = entries.filter((e) => e.status !== "voided");
  const voidedCount = entries.length - shown.length;
  const notice = STATE_NOTICES[state.data?.metafieldState];

  return (
    <s-admin-block heading="返金・商品券釣銭調整">
      <s-stack gap="base">
        {notice ? <s-banner tone="warning">{notice}</s-banner> : null}
        {shown.length === 0 ? (
          <s-text color="subdued">この注文の登録はありません。登録は POS の「返金」「商品券」タイルから行います。</s-text>
        ) : (
          <s-stack gap="small-200">
            {shown.map((e) => (
              <s-stack key={e.id} direction="inline" gap="small-200" alignItems="center">
                <s-text>{`${shortDate(e.date)} ${entryText(e)}`}</s-text>
                {STATUS_LABELS[e.status] ? <s-badge tone="warning">{STATUS_LABELS[e.status]}</s-badge> : null}
                {e.shopifyRefund?.status === "success" ? <s-badge>返金済</s-badge> : null}
              </s-stack>
            ))}
          </s-stack>
        )}
        {voidedCount > 0 ? <s-text color="subdued">{`無効にした登録 ${voidedCount} 件（履歴に残っています）`}</s-text> : null}
        {entries.length > 0 ? (
          <s-stack direction="inline">
            <s-button href={editHref}>変更・履歴を開く</s-button>
          </s-stack>
        ) : null}
      </s-stack>
    </s-admin-block>
  );
}
