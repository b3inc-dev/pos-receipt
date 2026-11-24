/**
 * 同期の結果と管理者設定を別フィールドとして保存する。
 * JSON 全体の古い読み取りで他の書き込みを戻さないよう、値が同じときだけ更新する。
 */
type SettingIdentity = { shopId: string; key: string };

export interface SyncSettingsStore {
  createMany(args: { data: SettingIdentity & { valueJson: string }; skipDuplicates: true }): Promise<unknown>;
  findUnique(args: { where: { shopId_key: SettingIdentity } }): Promise<{ valueJson: string } | null>;
  updateMany(args: { where: SettingIdentity & { valueJson: string }; data: { valueJson: string; updatedAt: Date } }): Promise<{ count: number }>;
}

export async function patchSyncSettings<T extends object>(
  store: SyncSettingsStore,
  shopId: string,
  key: string,
  defaults: T,
  patch: Partial<T>,
): Promise<void> {
  // 未保存の店でも並行する最初の保存と衝突しない。既存値は変えない。
  await store.createMany({ data: { shopId, key, valueJson: JSON.stringify(defaults) }, skipDuplicates: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await store.findUnique({ where: { shopId_key: { shopId, key } } });
    if (!row) throw new Error("Sync settings disappeared during update");
    let saved: Partial<T> = {};
    try {
      const parsed = JSON.parse(row.valueJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed;
    } catch {
      // getAppSetting と同じく、壊れた JSON は既定値として扱う。
    }
    const result = await store.updateMany({
      where: { shopId, key, valueJson: row.valueJson },
      data: { valueJson: JSON.stringify({ ...defaults, ...saved, ...patch }), updatedAt: new Date() },
    });
    if (result.count === 1) return;
    // 読んだあとに変更された。最新値を読み直し、担当フィールドだけを再適用する。
  }
  throw new Error("Sync settings changed repeatedly; retry the operation");
}
