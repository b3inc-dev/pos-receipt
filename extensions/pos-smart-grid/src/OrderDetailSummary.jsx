/**
 * 取引サマリー（Shopify POS 同等の情報表示）
 */
import { fmtYen, financialStatusLabel } from "./orderDisplayUtils.js";

function Row({ label, value, subdued }) {
  return (
    <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%" }}>
      <s-text tone={subdued ? "subdued" : undefined} size="small">{label}</s-text>
      <s-text size="small" style={{ textAlign: "right", maxInlineSize: "70%" }}>{value}</s-text>
    </s-stack>
  );
}

function Section({ title, children }) {
  return (
    <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
      <s-stack gap="small">
        <s-text fontWeight="bold" size="small">{title}</s-text>
        {children}
      </s-stack>
    </s-box>
  );
}

/**
 * @param {{ order: Record<string, unknown> | null }} props
 */
export function OrderDetailSummary({ order }) {
  if (!order) {
    return <s-text tone="subdued" size="small">取引情報を読み込めませんでした。</s-text>;
  }

  const lineItems = order.lineItems ?? [];
  const transactions = order.transactions ?? [];
  const refunds = order.refunds ?? [];
  const taxesIncluded = Boolean(order.taxesIncluded);

  return (
    <s-stack gap="base">
      <Section title="取引情報">
        <Row label="ステータス" value={financialStatusLabel(order.financialStatus, order.cancelledAt)} />
        <Row label="日時" value={order.transactionDateTime || order.transactionTime || "—"} />
        <Row label="ロケーション" value={order.location?.name || "—"} />
        <Row label="顧客" value={order.customer?.displayName || "顧客なし"} />
        {order.note ? <Row label="メモ" value={String(order.note)} subdued /> : null}
        {order.estimatedVoucherChange ? (
          <s-text tone="subdued" size="small">商品券釣有りの可能性があります</s-text>
        ) : null}
      </Section>

      {lineItems.length > 0 ? (
        <Section title={`商品（${lineItems.length}件）`}>
          {lineItems.map((li) => (
            <s-box key={li.id} padding="extraSmall">
              <s-stack gap="extraSmall">
                <s-text fontWeight="bold" size="small">
                  {li.title}
                  {li.variantTitle ? ` / ${li.variantTitle}` : ""}
                </s-text>
                <s-text tone="subdued" fontSize="small">
                  {li.quantity}点 × ¥{Number(li.discountedUnitPrice || li.originalUnitPrice || 0).toLocaleString()}
                  {" "}= ¥{Number(li.lineTotal || 0).toLocaleString()}
                </s-text>
                {li.sku ? (
                  <s-text tone="subdued" fontSize="small">SKU: {li.sku}</s-text>
                ) : null}
                {li.barcode ? (
                  <s-text tone="subdued" fontSize="small">バーコード: {li.barcode}</s-text>
                ) : null}
                {li.staffMemberName ? (
                  <s-text tone="subdued" fontSize="small">販売: {li.staffMemberName}</s-text>
                ) : null}
                {li.refundableQuantity != null ? (
                  <s-text tone="subdued" fontSize="small">返品可能: {li.refundableQuantity}点</s-text>
                ) : null}
                {(li.discounts ?? []).map((d, i) => (
                  <s-text key={i} tone="subdued" fontSize="small">
                    割引: {d.label} −¥{Number(d.amount || 0).toLocaleString()}
                  </s-text>
                ))}
                {(li.taxLines ?? []).map((t, i) => (
                  <s-text key={`tax-${i}`} tone="subdued" fontSize="small">
                    税: {t.title} ¥{Number(t.amount || 0).toLocaleString()}
                  </s-text>
                ))}
              </s-stack>
              <s-divider />
            </s-box>
          ))}
        </Section>
      ) : null}

      <Section title="金額">
        <Row label="小計" value={fmtYen(order.subtotalPrice?.amount)} />
        <Row label="割引" value={`−${fmtYen(order.totalDiscounts?.amount)}`} subdued />
        <Row label={taxesIncluded ? "税（込）" : "税"} value={fmtYen(order.totalTax?.amount)} />
        <Row label="合計" value={fmtYen(order.totalPrice?.amount)} />
      </Section>

      {transactions.length > 0 ? (
        <Section title="支払い">
          {transactions.map((tx) => (
            <Row
              key={tx.id || tx.displayName}
              label={tx.displayName || tx.gateway || "—"}
              value={fmtYen(tx.amount)}
            />
          ))}
        </Section>
      ) : null}

      {refunds.length > 0 ? (
        <Section title="返金">
          {refunds.map((r) => (
            <s-stack key={r.id} gap="extraSmall">
              <Row
                label={r.createdAt ? String(r.createdAt).slice(0, 16).replace("T", " ") : "返金"}
                value={fmtYen(r.totalRefunded)}
              />
              {(r.transactions ?? []).map((rtx, i) => (
                <Row
                  key={i}
                  label={rtx.displayName || rtx.gateway || "—"}
                  value={fmtYen(rtx.amount)}
                  subdued
                />
              ))}
            </s-stack>
          ))}
        </Section>
      ) : null}
    </s-stack>
  );
}
