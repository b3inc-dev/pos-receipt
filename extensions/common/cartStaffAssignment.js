/**
 * カート担当の純関数。
 * 表示名では割り当てない。安定したスタッフIDだけを使い、未確認の値は未分類のままにする。
 * 注文・メタフィールド・外部システムへの送信はここから行わない。
 */

export const CART_STAFF_EXTERNAL_SEND_ENABLED = false;

const STAFF_GID = /^gid:\/\/shopify\/StaffMember\/([1-9]\d*)$/;

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseStableStaffId(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^[1-9]\d*$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  const gid = STAFF_GID.exec(trimmed);
  if (!gid) return null;
  const parsed = Number(gid[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * @param {unknown} value
 * @returns {{ staffId: number | null, staffState: "unassigned" | "assigned" | "unclassified" }}
 */
export function classifyStaffValue(value) {
  if (value === null || value === undefined) {
    return { staffId: null, staffState: "unassigned" };
  }
  const staffId = parseStableStaffId(value);
  if (staffId == null) return { staffId: null, staffState: "unclassified" };
  return { staffId, staffState: "assigned" };
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {CartLine | null}
 */
export function normalizePosLine(raw) {
  const uuid = typeof raw?.uuid === "string" ? raw.uuid.trim() : "";
  if (!uuid) return null;
  const quantity = raw?.quantity;
  const quantityValid = typeof quantity === "number" && Number.isInteger(quantity) && quantity > 0;
  const variantRaw = raw?.variantId;
  const variantId =
    typeof variantRaw === "number" && Number.isInteger(variantRaw) && variantRaw > 0 ? variantRaw : null;
  const staff = classifyStaffValue(raw?.attributedUserId ?? raw?.staffId);
  const discounts = Array.isArray(raw?.discounts) ? raw.discounts.length : 0;
  const properties = raw?.properties;
  const propertyCount = Array.isArray(properties)
    ? properties.length
    : properties && typeof properties === "object"
      ? Object.keys(properties).length
      : 0;
  return {
    uuid,
    title: typeof raw?.title === "string" && raw.title.trim() ? raw.title.trim() : "商品",
    variantId,
    quantity: quantityValid ? quantity : null,
    quantityValid,
    staffId: staff.staffId,
    staffState: staff.staffState,
    discounts,
    propertyCount,
    hasSellingPlan: raw?.sellingPlan != null,
  };
}

/**
 * @param {unknown} lines
 */
export function createCartStaffState(lines) {
  const normalized = [];
  for (const raw of lines ?? []) {
    const line = raw?.uuid && raw?.quantityValid !== undefined && raw?.staffState ? raw : normalizePosLine(raw);
    if (line) normalized.push({ ...line });
  }
  return { checkout: "open", lines: normalized };
}

/**
 * @param {{ staffMemberId?: unknown, userId?: unknown } | null | undefined} session
 * @param {Array<{ staffId?: number | null }>} lines
 */
const APP_STAFF_KEY = /^app:[A-Za-z0-9_-]{8,}$/;

export function isAppStaffKey(value) {
  return typeof value === "string" && APP_STAFF_KEY.test(value);
}

export function rosterFromSessionAndLines(session, lines) {
  const ids = new Set();
  const pinnedStaffId = parseStableStaffId(session?.staffMemberId);
  if (pinnedStaffId) ids.add(pinnedStaffId);
  for (const line of lines ?? []) {
    if (typeof line?.staffId === "number") ids.add(line.staffId);
  }
  return {
    pinnedStaffId,
    roster: [...ids].map((id) => ({ id })),
  };
}

/**
 * 標準の担当IDがある候補を優先し、足りない分はアプリ内の担当を足す。
 * 表示名は一致キーにしない。
 * @param {Array<{ id?: number | null, key?: string, label?: string }>} sessionRoster
 * @param {Array<{ key?: string, label?: string }>} appStaff
 */
export function mergeStaffRoster(sessionRoster, appStaff) {
  const roster = [];
  for (const entry of sessionRoster ?? []) {
    const id = parseStableStaffId(entry?.id);
    if (id == null || roster.some((item) => item.id === id)) continue;
    roster.push({
      id,
      key: `shopify:${id}`,
      shopifyStaffId: id,
      label: entry?.label ?? null,
    });
  }
  for (const staff of appStaff ?? []) {
    if (!isAppStaffKey(staff?.key) || roster.some((item) => item.key === staff.key)) continue;
    roster.push({
      id: null,
      key: staff.key,
      shopifyStaffId: null,
      label: typeof staff.label === "string" ? staff.label : "",
    });
  }
  return roster;
}

function cloneState(state) {
  return {
    checkout: state?.checkout === "cancelled" ? "cancelled" : "open",
    lines: (state?.lines ?? []).map((line) => ({ ...line })),
  };
}

function rosterHas(roster, staffId) {
  return (roster ?? []).some((entry) => entry?.id === staffId);
}

function resolveRequestedStaff(staffId, roster) {
  if (staffId === null) {
    return { ok: true, staffId: null, staffKey: null, shopifyStaffId: null, staffState: "unassigned" };
  }
  if (isAppStaffKey(staffId)) {
    const found = (roster ?? []).find((entry) => entry?.key === staffId);
    if (!found) return { ok: false, code: "staff_unverified" };
    return {
      ok: true,
      staffId: null,
      staffKey: found.key,
      shopifyStaffId: null,
      staffState: "assigned",
    };
  }
  const parsed = parseStableStaffId(staffId);
  if (parsed == null || !rosterHas(roster, parsed)) {
    return { ok: false, code: "staff_unverified" };
  }
  return {
    ok: true,
    staffId: parsed,
    staffKey: `shopify:${parsed}`,
    shopifyStaffId: parsed,
    staffState: "assigned",
  };
}

function applyStaff(line, staff) {
  return {
    ...line,
    staffId: staff.staffId,
    staffKey: staff.staffKey,
    shopifyStaffId: staff.shopifyStaffId,
    staffState: staff.staffState,
    slices: staff.staffState === "unassigned"
      ? []
      : [{
        staffId: staff.staffId,
        staffKey: staff.staffKey,
        staffState: staff.staffState,
        quantity: line.quantity,
      }],
  };
}

function currentSlices(line) {
  if (line?.staffState === "unclassified") {
    return [{
      staffId: null,
      staffKey: null,
      staffState: "unclassified",
      quantity: line.quantity,
    }];
  }
  if (Array.isArray(line.slices) && line.slices.length > 0) {
    return line.slices.map((slice) => ({ ...slice }));
  }
  if (line.staffState === "assigned" && line.quantityValid) {
    return [{
      staffId: line.staffId ?? null,
      staffKey: line.staffKey ?? null,
      staffState: "assigned",
      quantity: line.quantity,
    }];
  }
  return [{
    staffId: null,
    staffKey: null,
    staffState: "unassigned",
    quantity: line.quantity,
  }];
}

function lineFromSlices(cartLine, slices) {
  const assigned = slices.filter((slice) => slice.staffState === "assigned");
  if (assigned.length === 1 && assigned[0].quantity === cartLine.quantity) {
    return {
      ...cartLine,
      slices,
      staffId: assigned[0].staffId ?? null,
      staffKey: assigned[0].staffKey ?? null,
      staffState: "assigned",
    };
  }
  if (assigned.length === 0) {
    return { ...cartLine, slices, staffId: null, staffKey: null, staffState: "unassigned" };
  }
  return { ...cartLine, slices, staffId: null, staffKey: null, staffState: "assigned" };
}

/**
 * 画面に残している担当順を、いまのカート数量へ合わせる。
 * 未分類の明細は未割当に変えない。
 * @param {Record<string, unknown>} cartLine
 * @param {Record<string, unknown> | null | undefined} saved
 */
export function reconcileStaffLine(cartLine, saved) {
  if (!saved || cartLine?.staffState === "unclassified" || !cartLine?.quantityValid) return cartLine;
  let slices = currentSlices(saved).filter((slice) => slice.staffState !== "unclassified");
  if (slices.length === 0) return cartLine;
  const quantity = cartLine.quantity;
  let sum = slices.reduce((total, slice) => total + slice.quantity, 0);
  if (sum < quantity) {
    slices = [...slices, {
      staffId: null,
      staffKey: null,
      staffState: "unassigned",
      quantity: quantity - sum,
    }];
  } else if (sum > quantity) {
    let over = sum - quantity;
    slices = slices.map((slice) => ({ ...slice }));
    for (let index = slices.length - 1; index >= 0 && over > 0; index -= 1) {
      const take = Math.min(slices[index].quantity, over);
      slices[index] = { ...slices[index], quantity: slices[index].quantity - take };
      over -= take;
    }
    slices = slices.filter((slice) => slice.quantity > 0);
  }
  return lineFromSlices(cartLine, slices);
}

function assignPartialSlices(line, quantity, staff) {
  const assigned = currentSlices(line).filter((slice) => slice.staffState === "assigned");
  const used = assigned.reduce((sum, slice) => sum + slice.quantity, 0);
  const open = line.quantity - used;
  if (quantity > open) return null;
  const next = assigned.map((slice) => ({ ...slice }));
  const last = next[next.length - 1];
  if (last && last.staffKey === staff.staffKey && last.staffId === staff.staffId) {
    next[next.length - 1] = { ...last, quantity: last.quantity + quantity };
  } else {
    next.push({
      staffId: staff.staffId,
      staffKey: staff.staffKey,
      staffState: staff.staffState,
      quantity,
    });
  }
  const remaining = open - quantity;
  if (remaining > 0) {
    next.push({
      staffId: null,
      staffKey: null,
      staffState: "unassigned",
      quantity: remaining,
    });
  }
  return next;
}

function staffMutation(kind, line, staff) {
  if (isAppStaffKey(staff.staffKey)) return { op: "record_app_staff" };
  if (kind === "cart") return { op: "set_cart_staff", staffId: staff.staffId };
  return { op: "set_line_staff", uuid: line.uuid, staffId: staff.staffId };
}

function fail(state, code) {
  return { ok: false, code, state: cloneState(state), mutations: [], externalSent: false };
}

function succeed(state, mutations) {
  return { ok: true, state, mutations, externalSent: false };
}

function lineIsBlocking(line) {
  return !line.quantityValid || line.staffState === "unclassified";
}

function canSplit(line) {
  return (
    line.quantityValid &&
    line.staffState !== "unclassified" &&
    line.variantId != null &&
    line.discounts === 0 &&
    line.propertyCount === 0 &&
    !line.hasSellingPlan
  );
}

export function isLineSplitAllowed(line) {
  return canSplit(line);
}

/**
 * @param {ReturnType<typeof createCartStaffState>} state
 * @param {Record<string, unknown>} action
 * @param {Array<{ id: number }>} roster
 */
export function reduceCartStaff(state, action, roster) {
  const current = cloneState(state);
  const type = action?.type;

  if (type === "cancel_checkout") {
    return succeed({ ...current, checkout: "cancelled" }, []);
  }

  if (type === "assign_cart") {
    if (current.lines.some(lineIsBlocking)) return fail(current, "cart_unclassified");
    const staff = resolveRequestedStaff(action.staffId, roster);
    if (!staff.ok) return fail(current, staff.code);
    const changed = current.lines.some(
      (line) => line.staffId !== staff.staffId || line.staffKey !== staff.staffKey || line.staffState !== staff.staffState,
    );
    const lines = current.lines.map((line) => applyStaff(line, staff));
    return succeed(
      { ...current, lines },
      changed ? [staffMutation("cart", null, staff)] : [],
    );
  }

  if (type === "assign_line" || type === "assign_partial" || type === "remove_line") {
    const index = current.lines.findIndex((line) => line.uuid === action.lineUuid);
    if (index < 0) return fail(current, "line_missing");
    const line = current.lines[index];

    if (type === "remove_line") {
      const lines = current.lines.filter((item) => item.uuid !== line.uuid);
      return succeed({ ...current, lines }, [{ op: "remove_line", uuid: line.uuid }]);
    }

    if (!line.quantityValid) return fail(current, "quantity_invalid");
    const staff = resolveRequestedStaff(action.staffId, roster);
    if (!staff.ok) return fail(current, staff.code);

    if (type === "assign_line" || action.quantity === line.quantity) {
      if (line.staffId === staff.staffId && line.staffKey === staff.staffKey && line.staffState === staff.staffState) {
        return succeed(current, []);
      }
      const lines = current.lines.map((item) =>
        item.uuid === line.uuid ? applyStaff(item, staff) : item,
      );
      return succeed(
        { ...current, lines },
        [staffMutation("line", line, staff)],
      );
    }

    const quantity = action.quantity;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity >= line.quantity) {
      return fail(current, "quantity_invalid");
    }
    if (line.staffState === "unclassified") return fail(current, "split_unclassified");

    if (isAppStaffKey(staff.staffKey)) {
      const slices = assignPartialSlices(line, quantity, staff);
      if (!slices) return fail(current, "quantity_invalid");
      const lines = current.lines.map((item) =>
        item.uuid === line.uuid
          ? { ...item, staffId: null, staffKey: null, shopifyStaffId: null, staffState: "assigned", slices }
          : item,
      );
      return succeed({ ...current, lines }, [{ op: "record_app_staff" }]);
    }

    if (!canSplit(line)) return fail(current, "split_blocked");

    const restStaffKey = line.staffKey ?? (line.staffId ? `shopify:${line.staffId}` : null);
    const restState = line.staffState === "assigned" ? "assigned" : "unassigned";
    const rest = {
      ...line,
      uuid: `${line.uuid}#rest`,
      quantity: line.quantity - quantity,
      staffId: line.staffId ?? null,
      staffKey: restStaffKey,
      shopifyStaffId: line.shopifyStaffId ?? line.staffId ?? null,
      staffState: restState,
      slices: [{
        staffId: line.staffId ?? null,
        staffKey: restStaffKey,
        staffState: restState,
        quantity: line.quantity - quantity,
      }],
    };
    const slice = {
      ...line,
      uuid: `${line.uuid}#slice`,
      quantity,
      staffId: staff.staffId,
      staffKey: staff.staffKey,
      shopifyStaffId: staff.shopifyStaffId,
      staffState: staff.staffState,
      slices: [{
        staffId: staff.staffId,
        staffKey: staff.staffKey,
        staffState: staff.staffState,
        quantity,
      }],
    };
    const lines = [
      ...current.lines.slice(0, index),
      rest,
      slice,
      ...current.lines.slice(index + 1),
    ];
    return succeed({ ...current, lines }, [
      {
        op: "split_variant",
        removeUuid: line.uuid,
        adds: [
          { variantId: line.variantId, quantity: rest.quantity, staffId: line.staffId },
          { variantId: line.variantId, quantity: slice.quantity, staffId: slice.staffId },
        ],
      },
    ]);
  }

  return fail(current, "unsupported_action");
}

export function summarizeCartStaff(lines) {
  const summary = {
    totalQty: 0,
    unassignedQty: 0,
    assignedQty: 0,
    unclassifiedCount: 0,
  };
  for (const line of lines ?? []) {
    if (!line.quantityValid || typeof line.quantity !== "number") {
      summary.unclassifiedCount += 1;
      continue;
    }
    summary.totalQty += line.quantity;
    if (line.staffState === "assigned") summary.assignedQty += line.quantity;
    else if (line.staffState === "unassigned") summary.unassignedQty += line.quantity;
    else summary.unclassifiedCount += 1;
  }
  return summary;
}

export function buildCartStaffRecord(lines) {
  return {
    lines: (lines ?? []).filter((line) => line.quantityValid).map((line) => {
      if (line.staffState === "unclassified") {
        return {
          uuid: line.uuid ?? null,
          variantId: line.variantId ?? null,
          quantity: line.quantity,
          placeholder: true,
          slices: [],
        };
      }
      return {
        uuid: line.uuid ?? null,
        variantId: line.variantId ?? null,
        quantity: line.quantity,
        placeholder: false,
        slices: currentSlices(line),
      };
    }),
  };
}

/**
 * 注文へ保存する担当順。未割当の数量は残し、担当が1つも無い明細は保存しない。
 * @param {Record<string, unknown>} line
 */
export function slicesToRecord(line) {
  const slices = Array.isArray(line?.slices) ? line.slices : [];
  const hasAssigned = slices.some((slice) => slice.staffState === "assigned" || slice.staffKey || slice.staffId != null);
  return hasAssigned ? slices : null;
}

/**
 * 決済後の明細へ、記録した順と数量を戻す。表示名では対応づけない。
 * 同じ商品・数量の並びが一致するときだけ戻す。
 * @param {Array<Record<string, unknown>>} orderLines
 * @param {Array<Record<string, unknown>>} draftLines
 */
function variantKey(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value !== "string") return null;
  const gid = /\/ProductVariant\/([1-9]\d*)$/.exec(value.trim());
  if (gid) return gid[1];
  return /^[1-9]\d*$/.test(value.trim()) ? value.trim() : null;
}

/**
 * 下書きは紐づいた注文以外へ返さない。
 * @param {{ boundOrderId?: string | null, lines?: Array<Record<string, unknown>> } | null | undefined} draft
 * @param {string} orderId
 */
export function draftLinesForOrder(draft, orderId) {
  if (!draft || !Array.isArray(draft.lines)) return [];
  if (draft.boundOrderId && String(draft.boundOrderId) !== String(orderId ?? "")) return [];
  return draft.lines;
}

function cartHasStandardStaff(cartLine) {
  return parseStableStaffId(cartLine?.staffId) != null || parseStableStaffId(cartLine?.shopifyStaffId) != null;
}

function draftIsAppAssignment(draft) {
  if (!draft || draft.placeholder === true) return false;
  const assigned = (Array.isArray(draft.slices) ? draft.slices : []).filter((slice) => (
    slice?.staffState === "assigned" || isAppStaffKey(slice?.staffKey)
  ));
  if (assigned.length === 0) return false;
  return assigned.every((slice) => isAppStaffKey(slice.staffKey) && parseStableStaffId(slice.staffId) == null);
}

/**
 * 保存した担当順を、同じ明細IDの現在カートへ戻す。
 * 戻すのはアプリ内の担当だけで、標準担当が付いている明細は変えない。
 * @param {Array<Record<string, unknown>>} cartLines
 * @param {Array<Record<string, unknown>>} draftLines
 */
export function overlayFromDraft(cartLines, draftLines) {
  const overlay = {};
  const used = new Set();
  for (const cartLine of cartLines ?? []) {
    if (cartHasStandardStaff(cartLine)) continue;
    const index = (draftLines ?? []).findIndex((draft, draftIndex) => (
      !used.has(draftIndex) && draft?.uuid && draft.uuid === cartLine.uuid
    ));
    if (index < 0) continue;
    const draft = draftLines[index];
    if (variantKey(draft.variantId) !== variantKey(cartLine.variantId)) continue;
    if (!draftIsAppAssignment(draft)) continue;
    used.add(index);
    overlay[cartLine.uuid] = reconcileStaffLine(cartLine, {
      ...cartLine,
      slices: draft.slices ?? [],
      staffState: "assigned",
    });
  }
  return overlay;
}

/**
 * 開き直しの担当順は、端末に残した下書きを優先する。
 * 操作が始まったあとは、遅い取得結果で上書きしない。
 * @param {{ localLines?: unknown, remoteLines?: unknown, edited?: boolean }} input
 */
export function planDraftRestore(input) {
  if (input?.edited) return { source: "keep", lines: [] };
  if (Array.isArray(input?.localLines) && input.localLines.length > 0) {
    return { source: "local", lines: input.localLines };
  }
  if (Array.isArray(input?.remoteLines) && input.remoteLines.length > 0) {
    return { source: "remote", lines: input.remoteLines };
  }
  return { source: "none", lines: [] };
}

export function restoreCartStaffRecord(orderLines, draftLines) {
  const pending = (draftLines ?? []).map((line) => ({
    variantId: variantKey(line.variantId),
    quantity: line.quantity,
    placeholder: line.placeholder === true || line.staffState === "unclassified",
    slices: Array.isArray(line.slices) ? line.slices.map((slice) => ({ ...slice })) : [],
  }));
  const restored = [];
  const unmatched = [];
  for (const orderLine of orderLines ?? []) {
    const variantId = variantKey(orderLine.variantId);
    const quantity = orderLine.quantity;
    const lineId = String(orderLine.id ?? orderLine.lineId ?? "");
    if (!lineId || variantId == null || typeof quantity !== "number") {
      unmatched.push(lineId);
      continue;
    }
    if (pending[0]?.placeholder && pending[0].variantId === variantId && pending[0].quantity === quantity) {
      pending.shift();
      unmatched.push(lineId);
      continue;
    }
    if (pending[0]?.placeholder) {
      unmatched.push(lineId);
      continue;
    }
    if (pending[0] && pending[0].variantId === variantId && pending[0].quantity === quantity) {
      restored.push({ lineId, quantity, sequenceKnown: true, slices: pending.shift().slices });
      continue;
    }
    let sum = 0;
    let count = 0;
    for (const item of pending) {
      if (item.placeholder || item.variantId !== variantId) break;
      sum += item.quantity;
      count += 1;
      if (sum >= quantity) break;
    }
    if (count > 0 && sum === quantity) {
      const taken = pending.splice(0, count);
      restored.push({
        lineId,
        quantity,
        sequenceKnown: true,
        slices: taken.flatMap((item) => item.slices),
      });
      continue;
    }
    unmatched.push(lineId);
  }
  return { restored, unmatched, leftover: pending.length };
}

export function allocationKey(lines) {
  return (lines ?? [])
    .map((line) =>
      [
        line.variantId ?? "",
        line.quantity ?? "",
        line.staffState,
        line.staffId ?? "",
      ].join(":"),
    )
    .sort()
    .join("|");
}

/**
 * 外部連携へは送らない。契約確認と送信有効化は別作業。
 * @param {unknown} _snapshot
 */
export function externalStaffDispatch(_snapshot) {
  return { sent: false, reason: "disabled" };
}

/**
 * @param {Array<Record<string, unknown>>} mutations
 * @param {Record<string, Function>} cart
 */
/**
 * 計画してからカートAPIへ反映する。外部送信は呼ばない。
 * @param {Array<Record<string, unknown>>} lines
 * @param {Record<string, unknown>} action
 * @param {Array<{ id: number }>} roster
 * @param {Record<string, Function>} cart
 */
export async function runCartStaffAction(lines, action, roster, cart) {
  const planned = reduceCartStaff({ checkout: "open", lines }, action, roster);
  if (!planned.ok || planned.mutations.length === 0) return planned;
  const applied = await applyCartStaffMutations(planned.mutations, cart);
  if (!applied.ok) {
    return {
      ok: false,
      code: applied.code,
      state: planned.state,
      mutations: planned.mutations,
      externalSent: false,
    };
  }
  return planned;
}

export async function applyCartStaffMutations(mutations, cart) {
  const invoked = [];
  const call = async (name, ...args) => {
    invoked.push(name);
    const fn = cart?.[name];
    if (typeof fn !== "function") {
      const error = new Error("cart_method_missing");
      error.code = "apply_failed";
      error.invoked = invoked.slice();
      throw error;
    }
    return await fn(...args);
  };

  const rollbackAdded = async (created) => {
    for (const line of created) {
      try {
        await call("removeLineItem", line.uuid);
      } catch {
        // 元明細はまだ残している。
      }
    }
  };

  try {
    for (const mutation of mutations ?? []) {
      if (mutation.op === "record_app_staff") {
        invoked.push("record_app_staff");
        continue;
      } else if (mutation.op === "set_cart_staff") {
        await call("setAttributedStaff", mutation.staffId === null ? undefined : mutation.staffId);
      } else if (mutation.op === "set_line_staff") {
        await call(
          "setAttributedStaffToLineItem",
          mutation.staffId === null ? undefined : mutation.staffId,
          mutation.uuid,
        );
      } else if (mutation.op === "remove_line") {
        await call("removeLineItem", mutation.uuid);
      } else if (mutation.op === "split_variant") {
        const created = [];
        try {
          for (const add of mutation.adds ?? []) {
            const uuid = await call("addLineItem", add.variantId, add.quantity);
            if (typeof uuid !== "string" || uuid.length === 0) {
              const error = new Error("add_rejected");
              error.code = "apply_failed";
              throw error;
            }
            created.push({ uuid, staffId: add.staffId ?? null });
          }
          for (const line of created) {
            await call(
              "setAttributedStaffToLineItem",
              line.staffId === null ? undefined : line.staffId,
              line.uuid,
            );
          }
          await call("removeLineItem", mutation.removeUuid);
        } catch (error) {
          await rollbackAdded(created);
          throw error;
        }
      } else {
        const error = new Error("unknown_mutation");
        error.code = "apply_failed";
        throw error;
      }
    }
    return { ok: true, invoked };
  } catch (error) {
    return {
      ok: false,
      code: error?.code || "apply_failed",
      invoked: error?.invoked || invoked,
    };
  }
}
