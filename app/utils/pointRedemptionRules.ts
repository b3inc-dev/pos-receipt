/**
 * 精算の「ポイント利用額」に数える割引の見分け方（DB / Shopify 非依存）。
 *
 * 会員ポイントのアプリは、ポイントの利用を Shopify の注文に「割引」として残す。アプリごとに形が違う。
 * - 旧 VIP: オンラインも POS も「VIP-」で始まる割引コード
 * - Shop Point（2026-11 から）: オンラインは「SP-POINT-」＋英数字の顧客専用コード（頭は Shop Point の設定で変えられる）、
 *   その前の形「SP」＋16 桁の 16 進のコードも残る。POS はコードの無いカートの割引（名前「Shop Point」）
 *
 * 前の注文の VIP- と旧形式も数え続けるので、初めの値はすべて入れておく。
 * 保存先は「ポイント/会員施策設定」（loyalty_settings）。保存していない店は初めの値で数える。
 * ciara-system の「会員ポイントの設定」（PR #979）と同じ考え方。Shop Point でコードの頭を変えたら両方を合わせる。
 */

export type PointRedemptionRules = {
  /** ポイント利用とみなす割引コードの頭（大文字にそろえる。ハイフンで終わる） */
  codePrefixes: string[];
  /** ポイント利用とみなす、コードの無い手入力の割引（POS のカートの割引）の名前 */
  manualTitles: string[];
  /** Shop Point の旧形式（SP ＋ 16 桁の 16 進、ハイフンなし）も数えるか */
  legacyShopPointHexCode: boolean;
};

export const DEFAULT_POINT_REDEMPTION_RULES: PointRedemptionRules = {
  codePrefixes: ["VIP-", "SP-POINT-"],
  manualTitles: ["Shop Point"],
  legacyShopPointHexCode: true,
};

export const POINT_CODE_PREFIXES_MAX = 10;
export const POINT_MANUAL_TITLES_MAX = 10;
export const POINT_CODE_PREFIX_LENGTH = { min: 3, max: 30 } as const;
export const POINT_MANUAL_TITLE_MAX_LENGTH = 60;

/** Shop Point の旧形式のコード（SP + 16 桁の 16 進） */
const LEGACY_SHOP_POINT_CODE = /^SP[0-9a-f]{16}$/i;

/**
 * コードの頭に使える形。半角の英数字とハイフンで、最後はハイフン。
 * 「VIP」「SP」のようにハイフンで終わらない頭は、ふつうのクーポン（VIPSALE・SPRING10）まで拾うので受け付けない。
 */
const PREFIX_RE = /^[A-Z0-9][A-Z0-9-]*-$/;

/** 名前のそろえ方。前後の空白を除き、半角の英字だけ大文字と小文字を区別しない */
function titleKey(raw: unknown): string {
  return typeof raw === "string"
    ? raw.normalize("NFKC").trim().replace(/[A-Z]/g, (c) => c.toLowerCase())
    : "";
}

/**
 * ポイント利用として数える割引か。
 * code は DiscountCodeApplication のコード、title は手入力の割引（Manual / Script）の名前。
 * コードがあるときはコードだけで決める（同じ名前でもコードの割引は名前で数えない）。
 */
export function isPointRedemption(
  code: string,
  title: string,
  rules: PointRedemptionRules = DEFAULT_POINT_REDEMPTION_RULES,
): boolean {
  const c = String(code ?? "").trim().toUpperCase();
  if (c) {
    if (rules.codePrefixes.some((p) => c.startsWith(p.toUpperCase()))) return true;
    return rules.legacyShopPointHexCode && LEGACY_SHOP_POINT_CODE.test(c);
  }
  const key = titleKey(title);
  if (!key) return false;
  return rules.manualTitles.some((t) => titleKey(t) === key);
}

function splitList(raw: unknown, separator: RegExp): string[] | null {
  if (raw == null) return null;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(separator) : null;
  if (!list) return null;
  return list
    .map((v) => (typeof v === "string" ? v.normalize("NFKC").trim() : ""))
    .filter((v) => v !== "");
}

function unique(values: string[], key: (v: string) => string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = key(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/**
 * 画面から来た値を確かめる。入れた順のまま、重なりは除く。
 * コードの頭は 1 行に 1 つ（カンマ・読点でも分ける）、名前は 1 行に 1 つ。
 */
export function validatePointRedemptionRules(input: {
  codePrefixes?: unknown;
  manualTitles?: unknown;
  legacyShopPointHexCode?: unknown;
}): { ok: true; rules: PointRedemptionRules } | { ok: false; error: string } {
  const prefixes = unique(
    (splitList(input.codePrefixes, /[\r\n,、]/) ?? []).map((p) => p.toUpperCase()),
    (p) => p,
  );
  if (prefixes.length === 0) {
    return {
      ok: false,
      error: "コードの頭を 1 つ以上入れてください（前の注文の「VIP-」も数えるので消さないでください）",
    };
  }
  if (prefixes.length > POINT_CODE_PREFIXES_MAX) {
    return { ok: false, error: `コードの頭は ${POINT_CODE_PREFIXES_MAX} 個までです` };
  }
  for (const p of prefixes) {
    if (
      p.length < POINT_CODE_PREFIX_LENGTH.min ||
      p.length > POINT_CODE_PREFIX_LENGTH.max ||
      !PREFIX_RE.test(p)
    ) {
      return {
        ok: false,
        error: `コードの頭「${p}」は、半角の英数字とハイフンで ${POINT_CODE_PREFIX_LENGTH.min}〜${POINT_CODE_PREFIX_LENGTH.max} 文字にし、最後をハイフンにしてください（「VIP-」「SP-POINT-」のように）`,
      };
    }
  }

  const titles = unique(splitList(input.manualTitles, /[\r\n]/) ?? [], titleKey);
  if (titles.length > POINT_MANUAL_TITLES_MAX) {
    return { ok: false, error: `割引の名前は ${POINT_MANUAL_TITLES_MAX} 個までです` };
  }
  for (const t of titles) {
    if (t.length > POINT_MANUAL_TITLE_MAX_LENGTH) {
      return { ok: false, error: `割引の名前は ${POINT_MANUAL_TITLE_MAX_LENGTH} 文字までです` };
    }
  }

  const legacy = input.legacyShopPointHexCode;
  return {
    ok: true,
    rules: {
      codePrefixes: prefixes,
      manualTitles: titles,
      legacyShopPointHexCode: legacy === false || legacy === "false" ? false : true,
    },
  };
}

/**
 * 保存された設定から精算で使う見分け方を作る。
 * 保存していない・壊れている項目は初めの値を使う（精算を止めず、旧 VIP も Shop Point も数え続ける）。
 */
export function resolvePointRedemptionRules(
  saved:
    | {
        pointRedemptionCodePrefixes?: unknown;
        pointRedemptionManualTitles?: unknown;
        pointRedemptionLegacyShopPointHexCode?: unknown;
      }
    | null
    | undefined,
): PointRedemptionRules {
  const d = DEFAULT_POINT_REDEMPTION_RULES;
  if (!saved) return { ...d, codePrefixes: [...d.codePrefixes], manualTitles: [...d.manualTitles] };
  const checked = validatePointRedemptionRules({
    codePrefixes: saved.pointRedemptionCodePrefixes ?? d.codePrefixes,
    manualTitles: saved.pointRedemptionManualTitles ?? d.manualTitles,
    legacyShopPointHexCode: saved.pointRedemptionLegacyShopPointHexCode,
  });
  if (!checked.ok) {
    return { ...d, codePrefixes: [...d.codePrefixes], manualTitles: [...d.manualTitles] };
  }
  // 名前の欄は空にできる（POS のポイントを数えない店）。保存していなければ初めの値
  return checked.rules;
}
