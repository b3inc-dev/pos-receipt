/**
 * 確定済み取引の明細担当。
 * 追加順が保存されているときだけ、残数のある先頭から返品を割り当てる。
 * 順序不明の取引は推測しない。訂正は記録だけで、決済・返金・在庫は変えない。
 * 連携データの送信と本番接続は無効。
 */
import { isAppStaffKey, parseStableStaffId } from "./cartStaffAssignment.js";

export const STAFF_ATTRIBUTION_PRODUCTION_CONNECTION_ENABLED = false;
export const STAFF_ATTRIBUTION_FORMAT = "order-staff-attribution";
export const STAFF_ATTRIBUTION_FORMAT_VERSION = 1;

const EFFECTS = {
  payment: "unchanged",
  refund: "unchanged",
  inventory: "unchanged",
};

function positiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function fail(code) {
  return { ok: false, code, effects: { ...EFFECTS } };
}

/**
 * 訂正画面の1点追加。null は未割当として扱う。
 * @param {Array<Record<string, unknown>>} slices
 * @param {{ staffId?: number | null, staffKey?: string | null } | null} choice
 */
export function appendStaffChoice(slices, choice) {
  const selected = choice && typeof choice === "object"
    ? { staffId: choice.staffId ?? null, staffKey: choice.staffKey ?? null }
    : { staffId: null, staffKey: null };
  const next = (slices ?? []).map((slice) => ({ ...slice }));
  const last = next[next.length - 1];
  const same = last && (
    (selected.staffKey && last.staffKey === selected.staffKey)
    || (!selected.staffKey && !last.staffKey && last.staffId === selected.staffId)
  );
  if (same) {
    next[next.length - 1] = { ...last, quantity: (last.quantity ?? 0) + 1 };
  } else {
    next.push({ ...selected, quantity: 1 });
  }
  return next;
}

export function isIsoDateTime(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const time = Date.parse(value);
  return Number.isFinite(time);
}

/**
 * 注文明細から、確認できた数量と返品数だけを読む。
 * 返品数が取れないときは null のままにし、担当へ割り当てない。
 * @param {Record<string, unknown>} line
 */
export function readLineQuantities(line) {
  const quantity = positiveInt(line?.quantity);
  if (quantity == null) return { quantity: null, returnedQuantity: null };
  const refundable = nonNegativeInt(line?.refundableQuantity);
  if (refundable == null || refundable > quantity) {
    return { quantity, returnedQuantity: null };
  }
  return { quantity, returnedQuantity: quantity - refundable };
}

function projectSlices(slices, returnedQuantity) {
  if (returnedQuantity == null) {
    return {
      slices: slices.map((slice) => ({
        ...slice,
        returnedQuantity: null,
        remainingQuantity: null,
      })),
      returnAllocations: [],
    };
  }
  let left = returnedQuantity;
  const returnAllocations = [];
  const projected = [];
  for (const slice of slices) {
    const take = Math.min(slice.quantity, left);
    left -= take;
    if (take > 0) {
      const allocation = {
        sequence: slice.sequence,
        staffId: slice.staffId,
        quantity: take,
      };
      if (slice.staffKey) allocation.staffKey = slice.staffKey;
      returnAllocations.push(allocation);
    }
    projected.push({
      ...slice,
      returnedQuantity: take,
      remainingQuantity: slice.quantity - take,
    });
  }
  return { slices: projected, returnAllocations };
}

/**
 * @param {Array<Record<string, unknown>>} rawSlices
 * @param {number} quantity
 */
export function normalizeExplicitSlices(rawSlices, quantity) {
  if (!Array.isArray(rawSlices) || rawSlices.length === 0) return fail("slices_required");
  const slices = [];
  let total = 0;
  for (const raw of rawSlices) {
    const sliceQuantity = positiveInt(raw?.quantity);
    if (sliceQuantity == null) return fail("quantity_invalid");
    let staffId = null;
    let staffKey = null;
    let staffState = "unassigned";
    if (isAppStaffKey(raw?.staffKey)) {
      staffKey = raw.staffKey;
      staffState = "assigned";
    } else if (raw?.staffId !== null && raw?.staffId !== undefined) {
      staffId = parseStableStaffId(raw.staffId);
      if (staffId == null) return fail("staff_unverified");
      staffState = "assigned";
    }
    total += sliceQuantity;
    const slice = {
      sequence: slices.length + 1,
      staffId,
      staffState,
      quantity: sliceQuantity,
    };
    if (staffKey) slice.staffKey = staffKey;
    slices.push(slice);
  }
  if (total !== quantity) return fail("quantity_mismatch");
  return { ok: true, slices };
}

/**
 * 保存済みの追加順があるときだけ返す。Shopify の表示名や単一担当からは順を作らない。
 * @param {Record<string, unknown>} line
 * @param {Record<string, unknown> | null | undefined} saved
 */
export function attributionFromConfirmedLine(line, saved) {
  const lineId = String(line?.id ?? line?.lineId ?? "").trim();
  const { quantity, returnedQuantity } = readLineQuantities(line);
  if (!lineId || quantity == null) return null;
  const unknown = {
    lineId,
    quantity,
    returnedQuantity,
    sequenceKnown: false,
    slices: [],
    returnAllocations: [],
  };
  if (!saved || saved.sequenceKnown !== true) return unknown;
  const normalized = normalizeExplicitSlices(saved.slices, quantity);
  if (!normalized.ok) return unknown;
  if (saved.quantity != null && saved.quantity !== quantity) return unknown;
  const projected = projectSlices(normalized.slices, returnedQuantity);
  return {
    lineId,
    quantity,
    returnedQuantity,
    sequenceKnown: true,
    slices: projected.slices,
    returnAllocations: projected.returnAllocations,
  };
}

/**
 * @param {Record<string, unknown>} input
 */
export function planOrderStaffCorrection(input) {
  const orderId = String(input?.orderId ?? "").trim();
  const lineId = String(input?.lineId ?? "").trim();
  const quantity = positiveInt(input?.quantity);
  const idempotencyKey = typeof input?.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (!orderId || !lineId) return fail("line_missing");
  if (!idempotencyKey) return fail("idempotency_key_required");
  if (!isIsoDateTime(input?.recordedAt)) return fail("recorded_at_required");
  if (quantity == null) return fail("quantity_invalid");
  const returnedQuantity = input?.returnedQuantity == null
    ? null
    : nonNegativeInt(input.returnedQuantity);
  if (input?.returnedQuantity != null && (returnedQuantity == null || returnedQuantity > quantity)) {
    return fail("quantity_invalid");
  }
  const previous = input?.previous ?? null;
  if (previous?.sequenceKnown === true && previous.quantity != null && previous.quantity !== quantity) {
    return fail("quantity_conflict");
  }
  const normalized = normalizeExplicitSlices(input?.slices, quantity);
  if (!normalized.ok) return normalized;
  const before = previous?.sequenceKnown === true
    ? attributionFromConfirmedLine(
      { id: lineId, quantity, refundableQuantity: returnedQuantity == null ? undefined : quantity - returnedQuantity },
      previous,
    )
    : {
      lineId,
      quantity,
      returnedQuantity,
      sequenceKnown: false,
      slices: [],
      returnAllocations: [],
    };
  const projected = projectSlices(normalized.slices, returnedQuantity);
  const after = {
    lineId,
    quantity,
    returnedQuantity,
    sequenceKnown: true,
    slices: projected.slices,
    returnAllocations: projected.returnAllocations,
  };
  return {
    ok: true,
    effects: { ...EFFECTS },
    record: {
      idempotencyKey,
      orderId,
      lineId,
      recordedAt: input.recordedAt,
      before,
      after,
      effects: { ...EFFECTS },
    },
  };
}

function persistenceRank(row) {
  const seq = Number.isInteger(row?.persistenceSeq) ? row.persistenceSeq : null;
  const parsed = Date.parse(row?.persistedAt ?? "");
  return {
    seq,
    time: Number.isFinite(parsed) ? parsed : null,
    id: String(row?.id ?? ""),
  };
}

function comparePersistence(left, right) {
  if (left.seq != null && right.seq != null && left.seq !== right.seq) return left.seq - right.seq;
  if (left.time != null && right.time != null && left.time !== right.time) return left.time - right.time;
  if (left.time != null && right.time == null) return 1;
  if (left.time == null && right.time != null) return -1;
  return 0;
}

/**
 * 訂正の鎖で、他の訂正から指されていない先端を返す。
 * 同じ保存時刻でも ID の文字順では選ばない。
 * @param {Array<Record<string, unknown>>} rows
 */
function selectChainTip(rows) {
  if (!rows.every((row) => typeof row?.previousCorrectionId === "string" && row?.id)) return null;
  const ids = new Set(rows.map((row) => row.id));
  const referenced = new Set(
    rows.map((row) => row.previousCorrectionId).filter((id) => ids.has(id)),
  );
  const tips = rows.filter((row) => !referenced.has(row.id));
  return tips.length === 1 ? tips[0] : null;
}

/**
 * 現在の訂正は保存の鎖の先端で選ぶ。端末時刻と ID の文字順は使わない。
 * @param {Array<Record<string, unknown>>} rows
 */
export function selectLatestCorrection(rows) {
  const list = (rows ?? []).filter(Boolean);
  const tip = selectChainTip(list);
  if (tip) return tip;
  let latest = null;
  let latestRank = null;
  for (const row of list) {
    const rank = persistenceRank(row);
    if (!latest || comparePersistence(rank, latestRank) > 0) {
      latest = row;
      latestRank = rank;
    }
  }
  return latest;
}

/**
 * @param {Array<Record<string, unknown>>} rows
 */
export function currentCorrectionsByLine(rows) {
  const grouped = new Map();
  for (const row of rows ?? []) {
    const key = String(row?.lineId ?? "");
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  return [...grouped.values()].map((list) => selectLatestCorrection(list)).filter(Boolean);
}

export function createMemoryAttributionStore() {
  const byKey = new Map();
  const byLine = [];
  let persistenceSeq = 0;
  return {
    async findByKey(key) {
      return byKey.get(key) ?? null;
    },
    async findLatestByLine(orderId, lineId) {
      const rows = byLine.filter((row) => row.orderId === orderId && row.lineId === lineId);
      return selectLatestCorrection(rows);
    },
    async insert(record, options = {}) {
      if (byKey.has(record.idempotencyKey)) {
        const error = new Error("duplicate");
        error.code = "duplicate";
        throw error;
      }
      if (options.expectedPreviousId !== undefined) {
        const lineRows = byLine.filter((row) => row.orderId === record.orderId && row.lineId === record.lineId);
        const latest = selectLatestCorrection(lineRows);
        const actual = latest?.id ?? "";
        const predecessorTaken = lineRows.some((row) => row.previousCorrectionId === options.expectedPreviousId);
        if (options.expectedPreviousId !== actual || predecessorTaken) {
          const error = new Error("predecessor_changed");
          error.code = "predecessor_changed";
          throw error;
        }
      }
      persistenceSeq += 1;
      const stored = {
        ...record,
        id: record.id ?? `mem-${persistenceSeq}`,
        persistenceSeq,
        previousCorrectionId: options.expectedPreviousId ?? "",
        persistedAt: new Date().toISOString(),
        before: structuredClone(record.before),
        after: structuredClone(record.after),
        effects: { ...record.effects },
      };
      byKey.set(record.idempotencyKey, stored);
      byLine.push(stored);
      return stored;
    },
  };
}

/**
 * 同じキーの再送は最初の記録を返し、担当数量を足さない。
 * @param {{ findByKey: Function, insert: Function }} store
 * @param {Record<string, unknown>} plan
 */
/**
 * 保存直前に直前の訂正を読み直し、同時保存で変更前がずれたら保存し直す。
 * @param {{ findByKey: Function, findLatestByLine: Function, insert: Function }} store
 * @param {Record<string, unknown>} input
 */
export async function commitOrderStaffCorrection(store, input) {
  const idempotencyKey = typeof input?.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (idempotencyKey) {
      const existing = await store.findByKey(idempotencyKey);
      if (existing) return { ok: true, duplicate: true, record: existing, effects: { ...EFFECTS } };
    }
    const latest = await store.findLatestByLine(input?.orderId, input?.lineId);
    const plan = planOrderStaffCorrection({
      ...input,
      previous: latest?.after ?? null,
    });
    if (!plan.ok) return plan;
    try {
      const saved = await store.insert(plan.record, { expectedPreviousId: latest?.id ?? "" });
      return { ok: true, duplicate: false, record: saved, effects: { ...EFFECTS } };
    } catch (error) {
      if (error?.code === "duplicate") {
        const raced = idempotencyKey ? await store.findByKey(idempotencyKey) : null;
        if (raced) return { ok: true, duplicate: true, record: raced, effects: { ...EFFECTS } };
      }
      if (error?.code === "predecessor_changed") continue;
      return fail("apply_failed");
    }
  }
  return fail("predecessor_conflict");
}

export async function applyOrderStaffCorrection(store, plan) {
  if (!plan?.ok || !plan.record) return plan?.ok === false ? plan : fail("unsupported_action");
  const existing = await store.findByKey(plan.record.idempotencyKey);
  if (existing) {
    return { ok: true, duplicate: true, record: existing, effects: { ...EFFECTS } };
  }
  try {
    const saved = await store.insert(plan.record);
    return { ok: true, duplicate: false, record: saved, effects: { ...EFFECTS } };
  } catch (error) {
    if (error?.code === "duplicate") {
      const raced = await store.findByKey(plan.record.idempotencyKey);
      return { ok: true, duplicate: true, record: raced, effects: { ...EFFECTS } };
    }
    return fail("apply_failed");
  }
}

/**
 * 連携先へ渡す形。この関数は送らない。
 * @param {string} orderId
 * @param {Array<Record<string, unknown>>} lines
 */
export function buildStaffAttributionPayload(orderId, lines) {
  return {
    format: STAFF_ATTRIBUTION_FORMAT,
    formatVersion: STAFF_ATTRIBUTION_FORMAT_VERSION,
    productionConnection: false,
    orderId,
    lines: (lines ?? []).map((line) => ({
      lineId: line.lineId,
      quantity: line.quantity,
      returnedQuantity: line.returnedQuantity,
      sequenceKnown: line.sequenceKnown === true,
      slices: (line.slices ?? []).map((slice) => ({
        sequence: slice.sequence,
        staffId: slice.staffId,
        quantity: slice.quantity,
        returnedQuantity: slice.returnedQuantity,
        remainingQuantity: slice.remainingQuantity,
      })),
      returnAllocations: line.sequenceKnown === true ? (line.returnAllocations ?? []) : [],
    })),
    effects: { ...EFFECTS },
  };
}

export function dispatchStaffAttributionPayload(_payload) {
  return { sent: false, reason: "production_connection_disabled", required: false };
}

/**
 * 保存済みの担当順を再表示用の一覧へ戻す。外部連携の成否は見ない。
 * @param {Array<Record<string, unknown>>} lines
 * @param {Record<string, unknown> | null | undefined} savedAfter
 */
export function mergeSavedLine(lines, savedAfter) {
  if (!savedAfter?.lineId) return [...(lines ?? [])];
  const rest = (lines ?? []).filter((line) => line.lineId !== savedAfter.lineId);
  return [...rest, savedAfter];
}
