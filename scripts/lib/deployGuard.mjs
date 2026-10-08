/**
 * 公開 / 自社デプロイ取り違え防止の純関数（server.js / deploy スクリプト共用）
 *
 * - APP_DISTRIBUTION の typo を起動時に拒否
 * - 既知 Render ホストと APP_DISTRIBUTION の組み合わせを検証
 * - extensions/common/appUrl.js の APP_MODE を検証
 *
 * SKIP_DISTRIBUTION_GUARD=1 で起動ガードをスキップ（緊急時のみ）
 */

export const KNOWN_PUBLIC_HOST_RE = /\/\/pos-receipt\.onrender\.com(\/|$)/i;
export const KNOWN_INHOUSE_HOST_RE = /\/\/pos-receipt-ciara\.onrender\.com(\/|$)/i;

export function normalizeAppDistribution(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

/**
 * @returns {{ ok: boolean, distribution: "public" | "inhouse", error?: string }}
 */
export function validateAppDistributionValue(raw) {
  const v = normalizeAppDistribution(raw);
  if (!v) return { ok: true, distribution: "public" };
  if (v === "public" || v === "inhouse") return { ok: true, distribution: v };
  return {
    ok: false,
    distribution: "public",
    error: `APP_DISTRIBUTION の値が不正です: "${String(raw)}"。inhouse / public / 未設定のいずれかにしてください。`,
  };
}

/**
 * 既知 Render URL のときだけ public/inhouse の取り違えをエラーにする。
 * 独自ドメイン等はスキップ（警告のみ）。
 *
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateAppUrlAgainstDistribution(appUrl, distributionRaw) {
  const distResult = validateAppDistributionValue(distributionRaw);
  if (!distResult.ok) {
    return { ok: false, errors: [distResult.error], warnings: [] };
  }
  const distribution = distResult.distribution;
  const url = String(appUrl ?? "").trim();
  const errors = [];
  const warnings = [];

  const isKnownPublic = KNOWN_PUBLIC_HOST_RE.test(url);
  const isKnownInhouse = KNOWN_INHOUSE_HOST_RE.test(url);

  if (!isKnownPublic && !isKnownInhouse) {
    if (url) {
      warnings.push(
        "SHOPIFY_APP_URL は既知の Render ホストではないため、public/inhouse ホスト照合をスキップしました。",
      );
    }
    return { ok: true, errors, warnings };
  }

  if (distribution === "inhouse" && isKnownPublic) {
    errors.push(
      "APP_DISTRIBUTION=inhouse ですが SHOPIFY_APP_URL が公開用ホスト (pos-receipt.onrender.com) です。自社用は pos-receipt-ciara.onrender.com と APP_DISTRIBUTION=inhouse を揃えてください。",
    );
  }
  if (distribution === "public" && isKnownInhouse) {
    errors.push(
      "APP_DISTRIBUTION が public（または未設定）ですが SHOPIFY_APP_URL が自社用ホスト (pos-receipt-ciara.onrender.com) です。自社用 Render では APP_DISTRIBUTION=inhouse を設定してください。",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** appUrl.js 内容から APP_MODE を読む */
export function readAppModeFromSource(content) {
  const m = String(content ?? "").match(/const\s+APP_MODE\s*=\s*"(public|inhouse)"\s*;/);
  return m?.[1] ?? null;
}

/**
 * @returns {{ ok: boolean, actual: string | null, error?: string }}
 */
export function assertAppModeEquals(expected, appUrlJsContent) {
  const actual = readAppModeFromSource(appUrlJsContent);
  if (actual !== expected) {
    return {
      ok: false,
      actual,
      error: `extensions/common/appUrl.js の APP_MODE が "${actual ?? "(未検出)"}" です。期待値: "${expected}"。deploy:public / deploy:inhouse を使ってください。`,
    };
  }
  return { ok: true, actual };
}

/**
 * サーバー起動時の総合チェック。SKIP_DISTRIBUTION_GUARD=1 なら ok。
 */
export function validateServerStartupEnv(env = process.env) {
  if (String(env.SKIP_DISTRIBUTION_GUARD ?? "").trim() === "1") {
    return {
      ok: true,
      errors: [],
      warnings: ["SKIP_DISTRIBUTION_GUARD=1 のため公開/自社ガードをスキップしました。"],
    };
  }

  const distCheck = validateAppDistributionValue(env.APP_DISTRIBUTION);
  if (!distCheck.ok) {
    return { ok: false, errors: [distCheck.error], warnings: [] };
  }

  const urlCheck = validateAppUrlAgainstDistribution(env.SHOPIFY_APP_URL, env.APP_DISTRIBUTION);
  return urlCheck;
}
