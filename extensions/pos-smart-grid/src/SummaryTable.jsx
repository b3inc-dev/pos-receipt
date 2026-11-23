/**
 * 精算・売上サマリーの表の部品（見出しで区切る形）。
 *
 *   売上                      ← 灰色の小さい見出し
 *   総売上            ¥238,400 ← 太字
 *     純売上          ¥216,727 ← 字下げ・灰色
 *   割引             −¥12,300 ← 差し引く金額は赤
 *
 * 枠は使わない（POS の s-box には枠・角丸・背景の指定が無く、書いても効かない）。
 * 使う部品と属性は POS UI 拡張 2025.10 の型にあるものだけ:
 * - s-text: type（generic / strong / small）・color（base / subdued）・tone
 *   （fontWeight・size・fontSize・emphasis は POS に無く、黙って無視される）
 * - s-box / s-stack: padding 系・inlineSize 系・gap・direction・alignItems・justifyContent
 * - s-section: heading（文字列）
 */
import { chunkRows, splitMetricItems } from "../../common/summaryTableLayout.js";

/** 表の中の見出し（売上・件数・支払方法別 など） */
export function SummaryHeading({ children, first = false }) {
  return (
    <s-box paddingBlockStart={first ? "none" : "base"} paddingBlockEnd="small-300">
      <s-text type="small" color="subdued">
        {children}
      </s-text>
    </s-box>
  );
}

/**
 * 1 行: 左に項目名、右に金額。
 * strong: 太字（合計など）。indent: 字下げして灰色（内訳）。tone: 金額の色（critical=赤 など）
 */
export function SummaryLine({ label, value, strong = false, indent = false, tone }) {
  const textType = strong ? "strong" : indent ? "small" : "generic";
  const labelColor = strong ? "base" : "subdued";
  return (
    <s-box paddingBlock="small-300" paddingInlineStart={indent ? "base" : "none"}>
      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
        <s-text type={textType} color={labelColor}>
          {label}
        </s-text>
        <s-text type={textType} color={indent && !tone ? "subdued" : "base"} tone={tone}>
          {value}
        </s-text>
      </s-stack>
    </s-box>
  );
}

/** 支払方法別の 1 行: 支払方法 / 件数 / 金額。indent は返金の行 */
export function PaymentLine({ label, count, amount, indent = false, tone }) {
  return (
    <s-box paddingBlock="small-300">
      {/* 字下げは項目名の欄の中だけ（行ごと下げると件数・金額の列が右にずれる） */}
      <s-stack direction="inline" gap="none" alignItems="center" inlineSize="100%">
        <s-box inlineSize="54%" minInlineSize="0" maxInlineSize="54%" paddingInlineStart={indent ? "base" : "none"}>
          <s-text type={indent ? "small" : "generic"} color={indent ? "subdued" : "base"}>
            {label}
          </s-text>
        </s-box>
        <s-box inlineSize="16%" minInlineSize="40px" maxInlineSize="16%">
          <s-stack direction="block" alignItems="end">
            <s-text type="small" color="subdued">
              {count}
            </s-text>
          </s-stack>
        </s-box>
        <s-box inlineSize="30%" minInlineSize="72px" maxInlineSize="30%">
          <s-stack direction="block" alignItems="end">
            <s-text type={indent ? "small" : "generic"} tone={tone}>
              {amount}
            </s-text>
          </s-stack>
        </s-box>
      </s-stack>
    </s-box>
  );
}

/**
 * 売上サマリーの店ごとのカード。
 * 1 行目: 店名と予算比バッジ（達成=緑、未達=赤）／ 2 行目: 実績を大きく ／ 予算 ／ 残りは 3 列。
 * items は既存の行（{label, value, ratio?}[]）。管理画面で OFF の項目は items に無いので出ない。
 */
export function MetricCard({ title, items, updatedLabel = "" }) {
  const { hero, budget, ratio, cells } = splitMetricItems(items);
  const subParts = [];
  if (budget) subParts.push(`${budget.label} ${budget.value}`);
  if (updatedLabel) subParts.push(updatedLabel);
  return (
    <s-section>
      <s-stack gap="small-300">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-text type="strong">{title}</s-text>
          {ratio ? (
            <s-badge tone={ratio.tone}>
              {ratio.label} {ratio.value}
            </s-badge>
          ) : null}
        </s-stack>
        {hero ? <s-heading>{hero.value}</s-heading> : null}
        {subParts.length > 0 ? (
          <s-text type="small" color="subdued">
            {subParts.join("　・　")}
          </s-text>
        ) : null}
        {cells.length > 0 ? (
          <s-box paddingBlockStart="small">
            <s-stack gap="small">
              {chunkRows(cells, 3).map((row, ri) => (
                <s-stack key={ri} direction="inline" gap="none" alignItems="start" inlineSize="100%">
                  {row.map((c, ci) => (
                    <s-box
                      key={`${c.label}-${ci}`}
                      inlineSize="33%"
                      minInlineSize="0"
                      maxInlineSize="33%"
                      paddingInlineEnd="small-300"
                    >
                      <s-stack gap="none">
                        <s-text type="small" color="subdued">
                          {c.label}
                        </s-text>
                        <s-text type="strong">{c.value}</s-text>
                      </s-stack>
                    </s-box>
                  ))}
                </s-stack>
              ))}
            </s-stack>
          </s-box>
        ) : null}
      </s-stack>
    </s-section>
  );
}
