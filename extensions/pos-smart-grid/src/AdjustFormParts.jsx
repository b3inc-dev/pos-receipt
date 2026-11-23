/**
 * 返金方法変更・返金前登録・商品券釣銭登録・会計前登録の入力と確認の画面で使う部品（T 2026-11-24）。
 * 注文の詳細（案B, OrderDetailSummary）と同じ考え方: 灰色の小さい見出しで区切り、
 * 1 行は「左に項目名・右に値」。確かめる所（変更後の返金方法・金額、釣銭）は大きく出す。
 * 使う属性は POS UI 拡張の型にあるものだけ（s-text: type / color / tone、s-heading）。
 */

/** 灰色の小さい見出し（区切り） */
export function FormHeading({ children }) {
  return (
    <s-box paddingBlockStart="base" paddingBlockEnd="small-300">
      <s-text type="small" color="subdued">
        {children}
      </s-text>
    </s-box>
  );
}

/** 1 行: 左に項目名、右に値。strong で両方太字 */
export function FormLine({ label, value, tone, strong = false }) {
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

/** 確かめる所を大きく: 小さい見出し + 大きな値 + 補足（任意） */
export function FormHero({ label, value, sub }) {
  return (
    <s-section>
      <s-stack gap="small-300">
        <s-text type="small" color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {sub ? <s-text type="small" color="subdued">{sub}</s-text> : null}
      </s-stack>
    </s-section>
  );
}

/** 金額の書き方 */
export function yen(v) {
  return `¥${Number(v || 0).toLocaleString("ja-JP")}`;
}
