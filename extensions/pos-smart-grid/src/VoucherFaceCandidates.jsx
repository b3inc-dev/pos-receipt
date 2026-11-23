/**
 * 額面の候補ボタン（1 行に等分。押すと額面の欄に入る。T 2026-11-24）
 * 幅いっぱいに均等に並べる作りは一覧の絞り込みと同じ（s-button に幅の指定が無いので、幅を割った s-box に入れる）
 */
import { voucherFaceCandidates } from "../../common/voucherFaceCandidates.js";

export function VoucherFaceCandidates({ amount, selected, onPick, disabled }) {
  const list = voucherFaceCandidates(amount);
  if (list.length === 0) return null;
  return (
    <s-stack gap="small-300">
      <s-text color="subdued">額面の候補（押すと入ります）</s-text>
      <s-stack direction="inline" gap="none" alignItems="center" inlineSize="100%">
        {list.map((v, i) => (
          <s-box
            key={v}
            inlineSize={`${(100 / list.length).toFixed(2)}%`}
            paddingInlineStart={i === 0 ? "none" : "small-500"}
            paddingInlineEnd={i === list.length - 1 ? "none" : "small-500"}
          >
            <s-button
              variant={Number(selected) === v ? "primary" : "secondary"}
              onClick={() => onPick(String(v))}
              disabled={disabled}
            >
              {`¥${v.toLocaleString("ja-JP")}`}
            </s-button>
          </s-box>
        ))}
      </s-stack>
    </s-stack>
  );
}
