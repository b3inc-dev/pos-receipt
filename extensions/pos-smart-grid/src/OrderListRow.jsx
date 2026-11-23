/**
 * 注文一覧の 1 行（POS 純正の「すべての注文」に合わせた形）。
 * 領収書・販売レシート・返金/商品券の一覧で同じものを使う。
 *
 *   #1017 • 山田 太郎                ¥2,230
 *   11月20日 19:04            （灰色の小さい字）
 *   [支払い済み] [返金済] …   （バッジを横に並べる）
 *
 * 行の間は線を引かず、余白で区切る（純正と同じ）。
 * 使う部品は POS UI 拡張 2025.10 にあるものだけ（s-clickable / s-box / s-stack / s-text / s-badge）。
 * s-text の太字は type="strong"、小さい字は type="small"、灰色は color="subdued"（fontWeight・size は POS に無い）。
 */

/**
 * @param {object} props
 * @param {string} props.title - 「#1017 • 山田 太郎」
 * @param {string} props.amountLabel - 「¥2,230」
 * @param {string} [props.dateTimeLabel] - 「今日 18:14」
 * @param {{ key: string, label: string, tone?: string }[]} [props.badges]
 * @param {() => void} [props.onClick] - 無いときは押せない行（発行履歴など）
 */
export function OrderListRow({ title, amountLabel, dateTimeLabel = "", badges = [], onClick }) {
  const body = (
      <s-box paddingBlock="small">
        <s-stack gap="small-300">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
            <s-text type="strong">{title}</s-text>
            <s-text type="strong">{amountLabel}</s-text>
          </s-stack>
          {dateTimeLabel ? (
            <s-text type="small" color="subdued">{dateTimeLabel}</s-text>
          ) : null}
          {badges.length > 0 ? (
            <s-box paddingBlockStart="small-300">
              <s-stack direction="inline" gap="small-300">
                {badges.map((b) => (
                  <s-badge key={b.key} tone={b.tone || "neutral"}>{b.label}</s-badge>
                ))}
              </s-stack>
            </s-box>
          ) : null}
        </s-stack>
      </s-box>
  );
  return onClick ? <s-clickable onClick={onClick}>{body}</s-clickable> : body;
}
