/**
 * LIFF 会員証が「この LINE ユーザー ID の顧客はだれか」を探すときに読む顧客メタフィールドの順番。
 *
 * 既定: `line_crm.line_user_id`（LINE CRM＝Shop CRM for LINE が書く項目）→ `socialplus.line`（SocialPlus と、LINE CRM の
 * 互換の書き込みが書く項目）。環境変数 `MEMBER_CARD_LINE_ID_METAFIELDS` に `<namespace>.<key>` をカンマ区切りで並べると
 * その順番になる（多くて 4 つ。形の合わないものは捨てる。1 つも残らなければ既定）。
 *
 * 顧客の LINE ユーザー ID は「並べた順で最初に値が入っている項目」の値とする。
 * LINE CRM の項目に値があれば、古い項目（socialplus.line）に別の ID が残っていても、そちらでは見つけない
 * （LINE CRM で連携し直した人を、前の LINE で見つけないため）。LINE CRM の項目がまだ空の人（埋める前）は古い項目で見つける。
 */

export type LineIdField = { namespace: string; key: string };

export const MEMBER_CARD_LINE_ID_METAFIELDS_ENV = "MEMBER_CARD_LINE_ID_METAFIELDS";
export const DEFAULT_LINE_ID_FIELDS: readonly LineIdField[] = [
  { namespace: "line_crm", key: "line_user_id" },
  { namespace: "socialplus", key: "line" },
];
const MAX_FIELDS = 4;

/** `$app:` の予約の namespace は、ほかのアプリの値なので読めない（Shopify の決まり）。形で断る。 */
const REF = /^([A-Za-z0-9_-]{2,255})\.([A-Za-z0-9_-]{2,64})$/;

export function parseLineIdFields(raw: string | undefined | null): LineIdField[] {
  if (typeof raw !== "string" || raw.trim() === "") return [...DEFAULT_LINE_ID_FIELDS];
  const fields: LineIdField[] = [];
  for (const token of raw.split(",")) {
    const match = REF.exec(token.trim());
    if (!match || match[1].startsWith("app--")) continue;
    if (fields.some((field) => field.namespace === match[1] && field.key === match[2])) continue;
    fields.push({ namespace: match[1], key: match[2] });
    if (fields.length === MAX_FIELDS) break;
  }
  return fields.length > 0 ? fields : [...DEFAULT_LINE_ID_FIELDS];
}

export function readLineIdFields(env: Record<string, string | undefined> = process.env): LineIdField[] {
  return parseLineIdFields(env[MEMBER_CARD_LINE_ID_METAFIELDS_ENV]);
}

export function fieldLabel(field: LineIdField): string {
  return `${field.namespace}.${field.key}`;
}

/** GraphQL の別名（lineField0, lineField1, …）。 */
export function lineFieldAlias(index: number): string {
  return `lineField${index}`;
}

/** customers の問い合わせに入れる、項目ごとの別名つきの読み取り（namespace・key は変数で渡す）。 */
export function lineFieldSelections(fields: readonly LineIdField[]): { selections: string; variableDefs: string; variables: Record<string, string> } {
  const selections: string[] = [];
  const defs: string[] = [];
  const variables: Record<string, string> = {};
  fields.forEach((field, index) => {
    selections.push(`${lineFieldAlias(index)}: metafield(namespace: $lineNs${index}, key: $lineKey${index}) { value }`);
    defs.push(`$lineNs${index}: String!`, `$lineKey${index}: String!`);
    variables[`lineNs${index}`] = field.namespace;
    variables[`lineKey${index}`] = field.key;
  });
  return { selections: selections.join("\n        "), variableDefs: defs.join(", "), variables };
}

/** 全件を見るときの検索（項目ごとに 1 つ）。例: `metafields.line_crm.line_user_id:*` */
export function fullScanQuery(field: LineIdField): string {
  return `metafields.${field.namespace}.${field.key}:*`;
}

/**
 * socialplus.line などの値を LINE ユーザー ID に正規化する。
 * 生の "Uxxx..." または JSON（{"provider":"line","uid":"Uxxx..."} 等）の両方に対応。
 */
export function normalizeStoredLineId(value: unknown): string | undefined {
  if (value == null) return undefined;
  const str = typeof value === "string" ? value.trim() : String(value).trim();
  if (!str) return undefined;
  try {
    const parsed = JSON.parse(str) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return str;
    const id = parsed.uid ?? parsed.id ?? parsed.line_user_id ?? parsed.userId;
    const idStr = typeof id === "string" ? id.trim() : id != null ? String(id).trim() : "";
    return idStr || str;
  } catch {
    return str;
  }
}

type Field = { value?: string | null } | null | undefined;

/** 顧客の LINE ユーザー ID: 並べた順で最初に値が入っている項目の値。 */
export function customerLineId(node: Record<string, unknown> | null | undefined, fields: readonly LineIdField[]): string | undefined {
  if (!node) return undefined;
  for (let index = 0; index < fields.length; index += 1) {
    const id = normalizeStoredLineId((node[lineFieldAlias(index)] as Field)?.value);
    if (id) return id;
  }
  return undefined;
}

/**
 * 前からの項目 `socialplus.line`。main と同じ動きを保つため、定義の確かめをせずに全件を見る
 * （エラーなら API_ERROR を返す）。ほかの項目は、定義で絞り込みが効くと確かめられたときだけ全件を見る。
 */
export const LEGACY_LINE_ID_FIELD: LineIdField = { namespace: "socialplus", key: "line" };

export function isLegacyLineIdField(field: LineIdField): boolean {
  return field.namespace === LEGACY_LINE_ID_FIELD.namespace && field.key === LEGACY_LINE_ID_FIELD.key;
}

/** 1 つの項目の値（並べた順の index の別名）。空なら undefined。 */
export function fieldLineId(node: Record<string, unknown> | null | undefined, index: number): string | undefined {
  if (!node) return undefined;
  return normalizeStoredLineId((node[lineFieldAlias(index)] as Field)?.value);
}
