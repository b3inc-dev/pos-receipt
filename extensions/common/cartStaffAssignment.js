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
  if (staffId === null) return { ok: true, staffId: null, staffState: "unassigned" };
  const parsed = parseStableStaffId(staffId);
  if (parsed == null || !rosterHas(roster, parsed)) {
    return { ok: false, code: "staff_unverified" };
  }
  return { ok: true, staffId: parsed, staffState: "assigned" };
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
      (line) => line.staffId !== staff.staffId || line.staffState !== staff.staffState,
    );
    const lines = current.lines.map((line) => ({
      ...line,
      staffId: staff.staffId,
      staffState: staff.staffState,
    }));
    return succeed(
      { ...current, lines },
      changed ? [{ op: "set_cart_staff", staffId: staff.staffId }] : [],
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
      if (line.staffId === staff.staffId && line.staffState === staff.staffState) {
        return succeed(current, []);
      }
      const lines = current.lines.map((item) =>
        item.uuid === line.uuid
          ? { ...item, staffId: staff.staffId, staffState: staff.staffState }
          : item,
      );
      return succeed(
        { ...current, lines },
        [{ op: "set_line_staff", uuid: line.uuid, staffId: staff.staffId }],
      );
    }

    const quantity = action.quantity;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity >= line.quantity) {
      return fail(current, "quantity_invalid");
    }
    if (line.staffState === "unclassified") return fail(current, "split_unclassified");
    if (!canSplit(line)) return fail(current, "split_blocked");

    const rest = {
      ...line,
      uuid: `${line.uuid}#rest`,
      quantity: line.quantity - quantity,
    };
    const slice = {
      ...line,
      uuid: `${line.uuid}#slice`,
      quantity,
      staffId: staff.staffId,
      staffState: staff.staffState,
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
      if (mutation.op === "set_cart_staff") {
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
