/**
 * POS で 1 つを選ぶ欄。
 *
 * POS の UI 拡張（@shopify/ui-extensions の point-of-sale）には s-select / s-option が無く、
 * 使うと何も描かれない（選ぶ欄が出ないまま初めの値で登録される）。
 * POS で使える s-choice-list / s-choice で作る。
 *
 * options: [{ value: string, label: string }]
 */
export function PosChoiceField({ label, value, options, onChange }) {
  const list = Array.isArray(options) ? options : [];
  const handleChange = (e) => {
    const values = e?.currentTarget?.values;
    const next = Array.isArray(values) ? values[0] : undefined;
    // 選ばれている項目をもう一度押して空になったときは、今の値のままにする
    if (next == null || next === "") return;
    if (next !== value) onChange(next);
  };
  return (
    <s-stack gap="small">
      {label ? <s-text type="strong">{label}</s-text> : null}
      <s-choice-list values={value != null && value !== "" ? [String(value)] : []} onChange={handleChange}>
        {list.map((o) => (
          <s-choice key={o.value} value={String(o.value)}>
            {o.label}
          </s-choice>
        ))}
      </s-choice-list>
    </s-stack>
  );
}

/**
 * POS のオン・オフ欄（s-checkbox の代わり）。POS には s-checkbox が無い。
 */
export function PosToggleField({ label, checked, onChange }) {
  const VALUE = "on";
  return (
    <s-choice-list
      multiple
      values={checked ? [VALUE] : []}
      onChange={(e) => {
        const values = e?.currentTarget?.values;
        onChange(Array.isArray(values) && values.includes(VALUE));
      }}
    >
      <s-choice value={VALUE}>{label}</s-choice>
    </s-choice-list>
  );
}
