/**
 * 履歴の画面の期間の欄（開始日・終了日）。UI ルール v1.1 の 6章・9章・13章。
 * Polaris の TextField type="date" には共通の日付欄の CSS（Admin-input）が当たらず、iPhone Safari で枠からはみ出すので、
 * 共通の CSS の欄にする。期間の欄はどれも同じ幅（168px、スマホは 2 つで 1 行）。値の扱いは今までどおり（YYYY-MM-DD の文字）。
 */
export function DateFilter({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="Admin-field" style={{ width: 168 }}>
      <label className="Admin-field-label" htmlFor={id}>{label}</label>
      <input
        id={id}
        className="Admin-input"
        type="date"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        data-not-form-value
      />
    </div>
  );
}
