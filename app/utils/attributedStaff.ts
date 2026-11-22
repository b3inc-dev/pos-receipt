/**
 * 販売の帰属スタッフ（Shopify POS で明細の販売に付いたスタッフ）
 *
 * 取り方（T 2026-11-23「販売担当ではなく帰属が必要」「領収書の発行者は帰属スタッフ」）
 * - スタッフ ID と数量: 注文 Webhook（orders/updated）の `line_items[].attributed_staffs`（`{ id, quantity }`）。
 *   `read_orders` だけで届く。注文の書き換えはしない。
 * - 名前: 管理画面「スタッフ名」で ID ごとに登録した表示名。
 *   `read_users` が付いている店（Plus / Advanced で Shopify が許可した店）だけ、Shopify の StaffMember の名前を優先する。
 *   Admin GraphQL の `LineItem.staffMember` / `StaffMember` は `read_users` が無いと読めない（ID も読めない）。
 *
 * このファイルは DB・Shopify を呼ばない（試験しやすくするため）。
 */

/** スタッフ ID を数字だけの文字列にそろえる（数・数字の文字列・StaffMember / User の GID）。おかしな値は null。 */
export function normalizeStaffId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s =
    typeof raw === "number"
      ? Number.isSafeInteger(raw) && raw > 0
        ? String(raw)
        : ""
      : typeof raw === "string"
        ? raw.trim()
        : "";
  const gid = /^gid:\/\/shopify\/(?:StaffMember|User)\/(\d+)$/.exec(s);
  if (gid) s = gid[1];
  if (!/^\d{1,20}$/.test(s)) return null;
  if (/^0+$/.test(s)) return null;
  return s.replace(/^0+/, "");
}

/** 注文 ID を数字だけにそろえる（数・数字の文字列・Order の GID）。 */
export function normalizeOrderId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "number" ? (Number.isSafeInteger(raw) && raw > 0 ? String(raw) : "") : String(raw).trim();
  const gid = /^gid:\/\/shopify\/Order\/(\d+)$/.exec(s);
  const id = gid ? gid[1] : s;
  return /^[1-9]\d{0,19}$/.test(id) ? id : null;
}

/** 明細 ID を数字だけにそろえる（数・数字の文字列・LineItem の GID）。 */
export function normalizeLineItemId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "number" ? (Number.isSafeInteger(raw) && raw > 0 ? String(raw) : "") : String(raw).trim();
  const gid = /^gid:\/\/shopify\/LineItem\/(\d+)$/.exec(s);
  const id = gid ? gid[1] : s;
  return /^[1-9]\d{0,19}$/.test(id) ? id : null;
}

/** 明細 1 つに付いた帰属 1 件 */
export type AttributionLine = {
  lineItemId: string;
  /** 明細の並び（Webhook の line_items の順・0 から） */
  position: number;
  staffId: string;
  quantity: number;
};

export type ParsedOrderAttribution = {
  orderId: string;
  /** Webhook の updated_at（古い通知で新しい記録を上書きしないため）。読めなければ null */
  sourceUpdatedAt: Date | null;
  /** POS 以外（オンラインストアなど）を含め、帰属が 1 件も無ければ空 */
  lines: AttributionLine[];
};

type PayloadLineItem = {
  id?: unknown;
  admin_graphql_api_id?: unknown;
  quantity?: unknown;
  attributed_staffs?: unknown;
};

/**
 * 注文 Webhook の本文から帰属を取り出す。
 * - `attributed_staffs` の `quantity` が無い・おかしいときは、その明細の数量（1 人だけのとき）か 1 にする。
 * - 同じ明細・同じスタッフが 2 回出たら数量を足す。
 * - 注文 ID が読めなければ null（記録しない）。
 */
export function parseOrderAttributionPayload(payload: unknown): ParsedOrderAttribution | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { id?: unknown; admin_graphql_api_id?: unknown; updated_at?: unknown; line_items?: unknown };
  const orderId = normalizeOrderId(p.id) ?? normalizeOrderId(p.admin_graphql_api_id);
  if (!orderId) return null;

  let sourceUpdatedAt: Date | null = null;
  if (typeof p.updated_at === "string") {
    const d = new Date(p.updated_at);
    if (!Number.isNaN(d.getTime())) sourceUpdatedAt = d;
  }

  const lines: AttributionLine[] = [];
  const items = Array.isArray(p.line_items) ? (p.line_items as PayloadLineItem[]) : [];
  items.forEach((li, position) => {
    if (!li || typeof li !== "object") return;
    const lineItemId = normalizeLineItemId(li.id) ?? normalizeLineItemId(li.admin_graphql_api_id);
    if (!lineItemId) return;
    const staffs = Array.isArray(li.attributed_staffs) ? (li.attributed_staffs as { id?: unknown; quantity?: unknown }[]) : [];
    const valid = staffs
      .map((s) => ({ staffId: normalizeStaffId(s?.id), quantity: positiveInt(s?.quantity) }))
      .filter((s): s is { staffId: string; quantity: number | null } => s.staffId !== null);
    const lineQty = positiveInt(li.quantity);
    const byStaff = new Map<string, number>();
    for (const s of valid) {
      const q = s.quantity ?? (valid.length === 1 && lineQty ? lineQty : 1);
      byStaff.set(s.staffId, (byStaff.get(s.staffId) ?? 0) + q);
    }
    for (const [staffId, quantity] of byStaff) {
      lines.push({ lineItemId, position, staffId, quantity });
    }
  });

  return { orderId, sourceUpdatedAt, lines };
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 注文 1 つの帰属スタッフ（明細の順に重複なし） */
export type AttributedStaff = {
  staffId: string;
  /** 表示名。登録も Shopify の名前も無ければ null */
  name: string | null;
  /** その注文でこのスタッフに付いた数量の合計 */
  quantity: number;
};

/**
 * 明細ごとの帰属を、注文の帰属スタッフの一覧にする。
 * 並びは最初に出た明細の順（同じ明細の中は記録の順）。名前は names（ID → 表示名）から引く。
 */
export function summarizeAttributedStaff(
  lines: Pick<AttributionLine, "staffId" | "quantity" | "position">[],
  names: Record<string, string | null | undefined> = {},
): AttributedStaff[] {
  const order: string[] = [];
  const qty = new Map<string, number>();
  const sorted = lines
    .map((l, i) => ({ ...l, i }))
    .sort((a, b) => a.position - b.position || a.i - b.i);
  for (const l of sorted) {
    if (!qty.has(l.staffId)) order.push(l.staffId);
    qty.set(l.staffId, (qty.get(l.staffId) ?? 0) + l.quantity);
  }
  return order.map((staffId) => ({
    staffId,
    name: cleanStaffName(names[staffId]),
    quantity: qty.get(staffId) ?? 0,
  }));
}

/** 表示名を整える（前後の空白を取り、空なら null、長すぎれば 60 文字で切る）。 */
export function cleanStaffName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 60) : null;
}

/** Shopify の StaffMember から表示名を作る（name → 姓 名）。 */
export function staffMemberDisplayName(
  staff: { name?: string | null; firstName?: string | null; lastName?: string | null } | null | undefined,
): string | null {
  if (!staff) return null;
  return (
    cleanStaffName(staff.name) ??
    cleanStaffName([staff.lastName, staff.firstName].map((v) => v?.trim()).filter(Boolean).join(" "))
  );
}

/** 1 人分の表示（名前が無ければ「スタッフ ID 123」）。 */
export function formatAttributedStaffLabel(staff: Pick<AttributedStaff, "staffId" | "name">): string {
  return staff.name ?? `スタッフ ID ${staff.staffId}`;
}

/** 注文の帰属スタッフを 1 行にする（「・」区切り）。いなければ空文字。 */
export function formatAttributedStaffList(staffs: Pick<AttributedStaff, "staffId" | "name">[]): string {
  return staffs.map(formatAttributedStaffLabel).join("・");
}

// ---- 管理画面「スタッフ名」の保存値（AppSetting） ----

export const STAFF_DISPLAY_NAMES_KEY = "staff_display_names_v1";

/** 保存の形: { names: { [staffId]: 表示名 } } */
export type StaffDisplayNames = { names: Record<string, string> };

/** 保存値を読み直す（形のおかしいものは捨てる）。 */
export function parseStaffDisplayNames(raw: unknown): StaffDisplayNames {
  const out: Record<string, string> = {};
  const names = raw && typeof raw === "object" ? (raw as { names?: unknown }).names : null;
  if (names && typeof names === "object" && !Array.isArray(names)) {
    for (const [k, v] of Object.entries(names as Record<string, unknown>)) {
      const id = normalizeStaffId(k);
      const name = cleanStaffName(v);
      if (id && name) out[id] = name;
    }
  }
  return { names: out };
}

/** 一度に登録できる人数の上限（画面と保存の両方で使う） */
export const STAFF_DISPLAY_NAMES_MAX = 500;

export type StaffNameRowInput = { staffId: string; name: string };
export type StaffNameRowError = { row: number; message: string };

/**
 * 管理画面から送られた行を保存値にする。
 * - ID も名前も空の行は捨てる。名前を空にした行はその ID の登録を消す。
 * - ID が数字でない・同じ ID が 2 回・名前だけある行は、行番号つきのエラーにする（保存しない）。
 */
export function buildStaffDisplayNames(rows: StaffNameRowInput[]): { value: StaffDisplayNames; errors: StaffNameRowError[] } {
  const names: Record<string, string> = {};
  const seen = new Set<string>();
  const errors: StaffNameRowError[] = [];
  rows.forEach((r, i) => {
    const row = i + 1;
    const rawId = (r.staffId ?? "").trim();
    const name = cleanStaffName(r.name);
    if (!rawId && !name) return;
    const id = normalizeStaffId(rawId);
    if (!id) {
      errors.push({ row, message: `${row} 行目: スタッフ ID は数字で入れてください` });
      return;
    }
    if (seen.has(id)) {
      errors.push({ row, message: `${row} 行目: スタッフ ID ${id} が 2 回あります` });
      return;
    }
    seen.add(id);
    if (name) names[id] = name;
  });
  if (Object.keys(names).length > STAFF_DISPLAY_NAMES_MAX) {
    errors.push({ row: 0, message: `登録は ${STAFF_DISPLAY_NAMES_MAX} 人までです` });
  }
  return { value: { names }, errors };
}

/** access token のスコープの文字列に read_users があるか（"read_orders,read_users" など）。 */
export function scopeIncludesReadUsers(scope: string | null | undefined): boolean {
  if (!scope) return false;
  return scope
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .some((s) => s === "read_users" || s === "write_users");
}
