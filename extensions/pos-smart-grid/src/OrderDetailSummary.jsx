/**
 * 注文の詳細（返金・商品券の画面）。調整に要る所を上に置く形（T 選択: 案B, 2026-11-23）。
 *
 *   ┌ 合計 ───────────────┐
 *   │ ¥3,325（大きく）       │
 *   │ 支払い ・ 現金   ¥3,325 │
 *   │ 返金 ・ 現金   −¥1,100 │ ← 赤
 *   └──────────────────┘
 *   商品（1件）                 ← 灰色の小さい見出し
 *   BBB バスタオル      ¥3,325  ← 太字
 *   Navy ・ 1点 × ¥3,325        ← 灰色の小さい字
 *   金額の内訳 / 取引情報
 *
 * 使う部品と属性は POS UI 拡張 2025.10 の型にあるものだけ:
 * - s-text: type（generic / strong / small）・color（base / subdued）・tone
 *   （fontWeight・size・fontSize・emphasis は POS に無く、黙って無視される）
 * - s-section（枠）・s-heading（大きな数字）
 * 見せ方だけで、数え方・登録の動きは変えない。
 */
import { fmtYen } from "./orderDisplayUtils.js";
import { customerLabel, orderPaymentSummaryLines } from "../../common/orderDetailLayout.js";

/** 灰色の小さい見出し（商品・金額の内訳・取引情報） */
function Heading({ children }) {
  return (
    <s-box paddingBlockStart="base" paddingBlockEnd="small-300">
      <s-text type="small" color="subdued">
        {children}
      </s-text>
    </s-box>
  );
}

/** 1 行: 左に灰色の項目名、右に値 */
function Line({ label, value, tone, strong = false }) {
  return (
    <s-box paddingBlock="small-300">
      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
        <s-text type={strong ? "strong" : "generic"} color={strong ? "base" : "subdued"}>
          {label}
        </s-text>
        <s-text type={strong ? "strong" : "generic"} tone={tone}>
          {value}
        </s-text>
      </s-stack>
    </s-box>
  );
}

function yenOf(v) {
  return `¥${Number(v || 0).toLocaleString("ja-JP")}`;
}

/** 商品 1 件: 名前と金額を太字、色・数量・SKU などは灰色の小さい字 */
function LineItem({ li }) {
  const sub1 = [
    li.variantTitle || "",
    `${li.quantity}点 × ${yenOf(li.discountedUnitPrice || li.originalUnitPrice)}`,
  ].filter(Boolean);
  const sub2 = [
    li.sku ? `SKU ${li.sku}` : "",
    li.barcode ? `バーコード ${li.barcode}` : "",
    li.refundableQuantity != null ? `返品できる数 ${li.refundableQuantity}点` : "",
  ].filter(Boolean);
  return (
    <s-box paddingBlock="small-300">
      <s-stack gap="none">
        <s-stack direction="inline" justifyContent="space-between" alignItems="start" gap="base">
          <s-text type="strong">{li.title}</s-text>
          <s-text type="strong">{yenOf(li.lineTotal)}</s-text>
        </s-stack>
        <s-text type="small" color="subdued">{sub1.join(" ・ ")}</s-text>
        {sub2.length > 0 ? <s-text type="small" color="subdued">{sub2.join(" ・ ")}</s-text> : null}
        {li.staffMemberName ? <s-text type="small" color="subdued">販売 {li.staffMemberName}</s-text> : null}
        {(li.discounts ?? []).map((d, i) => (
          <s-text key={i} type="small" color="subdued">
            割引 {d.label} −{yenOf(d.amount)}
          </s-text>
        ))}
        {(li.taxLines ?? []).map((t, i) => (
          <s-text key={`tax-${i}`} type="small" color="subdued">
            税 {t.title} {yenOf(t.amount)}
          </s-text>
        ))}
      </s-stack>
    </s-box>
  );
}

/**
 * @param {{ order: Record<string, unknown> | null }} props
 */
export function OrderDetailSummary({ order }) {
  if (!order) {
    return <s-text color="subdued">取引情報を読み込めませんでした。</s-text>;
  }

  const lineItems = order.lineItems ?? [];
  const taxesIncluded = Boolean(order.taxesIncluded);
  const moneyLines = orderPaymentSummaryLines(order);
  const discount = Number(order.totalDiscounts?.amount || 0);

  return (
    <s-stack gap="none">
      {/* 調整に要る所: 合計・支払い・返金 */}
      <s-section>
        <s-stack gap="small-300">
          <s-text type="small" color="subdued">合計</s-text>
          <s-heading>{fmtYen(order.totalPrice?.amount)}</s-heading>
          <s-box paddingBlockStart="small-300">
            {moneyLines.length > 0 ? (
              moneyLines.map((l) => <Line key={l.key} label={l.label} value={l.value} tone={l.tone} />)
            ) : (
              <s-text type="small" color="subdued">支払いの記録を読めませんでした。</s-text>
            )}
          </s-box>
          {order.estimatedVoucherChange ? (
            <s-text type="small" color="subdued">商品券釣有りの可能性があります</s-text>
          ) : (order.transactions ?? []).length > 0 ? (
            <s-text type="small" color="subdued">商品券釣有りの支払いが無いため、商品券釣銭調整はできません</s-text>
          ) : null}
        </s-stack>
      </s-section>

      {lineItems.length > 0 ? (
        <>
          <Heading>{`商品（${lineItems.length}件）`}</Heading>
          {lineItems.map((li) => (
            <LineItem key={li.id} li={li} />
          ))}
        </>
      ) : null}

      <Heading>金額の内訳</Heading>
      {/* Shopify の subtotalPrice は割引のあとの額。純正と同じく「小計（割引前）→ 割引 → 合計」と読めるよう、割引を足し戻して出す */}
      <Line label="小計" value={fmtYen(Number(order.subtotalPrice?.amount || 0) + discount)} />
      <Line label="割引" value={discount > 0 ? `−${fmtYen(discount)}` : fmtYen(0)} tone={discount > 0 ? "critical" : undefined} />
      <Line label={taxesIncluded ? "税（込）" : "税"} value={fmtYen(order.totalTax?.amount)} />

      <Heading>取引情報</Heading>
      <Line label="店舗" value={order.location?.name || "—"} />
      <Line label="顧客" value={customerLabel(order)} />
      {order.note ? <Line label="メモ" value={String(order.note)} /> : null}
    </s-stack>
  );
}
