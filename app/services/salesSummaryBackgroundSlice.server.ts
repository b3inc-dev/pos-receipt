/**
 * 日次売上のバックグラウンド再計算をスライス単位で進める。
 * 1 件が throw しても他スライスは続行し、失敗スライスの run は途中で例外にするため
 * 呼び出し側は成功した run だけを確定値として保存する。
 */

export async function runBackgroundDailySlices(
  slices: Array<{ label: string; run: () => Promise<void> }>,
): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  for (const slice of slices) {
    try {
      await slice.run();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`${slice.label}: ${message}`);
    }
  }
  return { errors };
}

/** 一部でも未完了なら、キューまたは Webhook の再送で同じ日次を取り直す。 */
export function backgroundRefreshNeedsRetry(errors: string[]): boolean {
  return errors.length > 0;
}
