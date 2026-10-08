/**
 * プライバシーポリシー URL の解決。
 * 優先: AppSetting（一般設定）→ 環境変数 PRIVACY_POLICY_URL。
 * ダミー固定 URL は置かない。未設定時は null。
 */

const HTTP_URL_RE = /^https?:\/\/.+/i;

export function isAllowedPrivacyPolicyUrl(raw: string): boolean {
  const url = raw.trim();
  if (!url || url.length > 2048) return false;
  if (!HTTP_URL_RE.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * @param settingsUrl AppSetting general_settings.privacyPolicyUrl
 * @param envUrl process.env.PRIVACY_POLICY_URL（省略時は環境から読む）
 */
export function resolvePrivacyPolicyUrl(
  settingsUrl?: string | null,
  envUrl?: string | null
): string | null {
  const fromSettings = (settingsUrl ?? "").trim();
  if (fromSettings && isAllowedPrivacyPolicyUrl(fromSettings)) {
    return fromSettings;
  }
  const fromEnv = (envUrl ?? process.env.PRIVACY_POLICY_URL ?? "").trim();
  if (fromEnv && isAllowedPrivacyPolicyUrl(fromEnv)) {
    return fromEnv;
  }
  return null;
}
