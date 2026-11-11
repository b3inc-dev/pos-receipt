import { useEffect, useState } from "preact/hooks";
import {
  createCartStaffState,
  isLineSplitAllowed,
  rosterFromSessionAndLines,
  summarizeCartStaff,
} from "../../common/cartStaffAssignment.js";

const ERROR_TEXT = {
  staff_unverified: "担当IDを確認できないため、設定しませんでした。",
  line_missing: "対象の明細がカートにありません。",
  quantity_invalid: "分ける数量が明細の数量と合いません。",
  split_blocked: "割引、付属情報、定期購買のある明細は数量を分けられません。明細全体の担当は変更できます。",
  cart_unclassified: "未分類の明細があるため、カート全体は変更しません。明細ごとに設定してください。",
  apply_failed: "カートへの反映に失敗しました。数量と担当を確認してください。",
  unsupported_action: "この操作はできません。",
};

function staffLabel(line, pinnedStaffId, roster) {
  if (!line.quantityValid || line.staffState === "unclassified") return "未分類";
  if (line.staffState !== "assigned" || line.staffId == null) return "未割当";
  if (line.staffId === pinnedStaffId) return "ログイン中の担当";
  const otherIds = (roster ?? []).filter((entry) => entry.id !== pinnedStaffId);
  if (otherIds.length > 1) return `明細の担当 ${line.staffId}`;
  return "明細の担当";
}

function rosterLabel(id, pinnedStaffId, roster) {
  if (id === pinnedStaffId) return "ログイン中の担当";
  const otherIds = (roster ?? []).filter((entry) => entry.id !== pinnedStaffId);
  if (otherIds.length > 1) return `明細の担当 ${id}`;
  return "明細の担当";
}

export function cartStaffErrorText(code) {
  return ERROR_TEXT[code] ?? "担当を反映できませんでした。";
}

function readCart() {
  try {
    return shopify?.cart?.current?.value ?? null;
  } catch {
    return null;
  }
}

function readSession() {
  try {
    return shopify?.session?.currentSession ?? null;
  } catch {
    return null;
  }
}

export function useCartStaffSnapshot() {
  const [cart, setCart] = useState(readCart);
  useEffect(() => {
    const current = shopify?.cart?.current;
    if (!current || typeof current.subscribe !== "function") return undefined;
    return current.subscribe((next) => setCart(next));
  }, []);
  const lines = createCartStaffState(cart?.lineItems ?? []).lines;
  const { roster, pinnedStaffId } = rosterFromSessionAndLines(readSession(), lines);
  return {
    lines,
    roster,
    pinnedStaffId,
    editable: cart?.editable ?? true,
  };
}

export function CartStaffPanel({
  lines,
  roster,
  pinnedStaffId,
  editable,
  busy,
  error,
  scope = "cart",
  onAction,
}) {
  const [splitQty, setSplitQty] = useState({});
  const summary = summarizeCartStaff(lines);
  const blocked = (lines ?? []).some((line) => !line.quantityValid || line.staffState === "unclassified");
  const disabled = !editable || busy;

  const run = (action) => {
    if (disabled) return;
    onAction(action);
  };

  const changeSplit = (uuid, quantity, delta) => {
    setSplitQty((prev) => {
      const current = prev[uuid] ?? 1;
      const next = Math.min(quantity - 1, Math.max(1, current + delta));
      return { ...prev, [uuid]: next };
    });
  };

  return (
    <s-page heading={scope === "line" ? "明細の担当" : "販売担当"}>
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text color="subdued">
              設定はこのレジのカートに残ります。決済を中止しても、残った明細の担当と数量は維持されます。
            </s-text>
            {!editable ? <s-text tone="critical">いまのカートは変更できません。</s-text> : null}
            {error ? <s-text tone="critical">{error}</s-text> : null}
            <s-text>
              {`未割当 ${summary.unassignedQty}点 / 割当済み ${summary.assignedQty}点`}
              {summary.unclassifiedCount > 0 ? ` / 未分類 ${summary.unclassifiedCount}件` : ""}
            </s-text>

            {scope === "cart" ? (
              <s-stack gap="base">
                {blocked ? (
                  <s-text color="subdued">未分類の明細があるため、カート全体は変更しません。</s-text>
                ) : null}
                {(roster ?? []).map((entry) => (
                  <s-button
                    key={`cart-${entry.id}`}
                    disabled={disabled || blocked || (lines ?? []).length === 0}
                    onClick={() => run({ type: "assign_cart", staffId: entry.id })}
                  >
                    {`カート全体を${rosterLabel(entry.id, pinnedStaffId, roster)}にする`}
                  </s-button>
                ))}
                <s-button
                  disabled={disabled || blocked || (lines ?? []).length === 0}
                  onClick={() => run({ type: "assign_cart", staffId: null })}
                >
                  カート全体を未割当にする
                </s-button>
                {(roster ?? []).length === 0 ? (
                  <s-text color="subdued">ログイン中の担当IDを確認できないため、未割当以外は設定できません。</s-text>
                ) : null}
              </s-stack>
            ) : null}

            {(lines ?? []).length === 0 ? <s-text>カートに商品がありません。</s-text> : null}

            {(lines ?? []).map((line) => {
              const selectedSplit = splitQty[line.uuid] ?? 1;
              const splitAllowed = isLineSplitAllowed(line);
              return (
                <s-box key={line.uuid} padding="small">
                  <s-stack gap="base">
                    <s-text type="strong">
                      {`${line.title} × ${line.quantityValid ? line.quantity : "—"}`}
                    </s-text>
                    <s-text color="subdued">{staffLabel(line, pinnedStaffId, roster)}</s-text>
                    {(roster ?? []).map((entry) => (
                      <s-button
                        key={`${line.uuid}-${entry.id}`}
                        disabled={disabled || !line.quantityValid}
                        onClick={() => run({ type: "assign_line", lineUuid: line.uuid, staffId: entry.id })}
                      >
                        {`この明細を${rosterLabel(entry.id, pinnedStaffId, roster)}にする`}
                      </s-button>
                    ))}
                    <s-button
                      disabled={disabled || !line.quantityValid}
                      onClick={() => run({ type: "assign_line", lineUuid: line.uuid, staffId: null })}
                    >
                      この明細を未割当にする
                    </s-button>
                    {splitAllowed ? (
                      <s-stack gap="base">
                        <s-text>{`${selectedSplit}点だけ分ける`}</s-text>
                        <s-stack direction="inline" gap="base">
                          <s-button
                            disabled={disabled || selectedSplit <= 1}
                            onClick={() => changeSplit(line.uuid, line.quantity, -1)}
                          >
                            −
                          </s-button>
                          <s-button
                            disabled={disabled || selectedSplit >= line.quantity - 1}
                            onClick={() => changeSplit(line.uuid, line.quantity, 1)}
                          >
                            ＋
                          </s-button>
                        </s-stack>
                        {(roster ?? []).map((entry) => (
                          <s-button
                            key={`${line.uuid}-part-${entry.id}`}
                            disabled={disabled}
                            onClick={() =>
                              run({
                                type: "assign_partial",
                                lineUuid: line.uuid,
                                quantity: selectedSplit,
                                staffId: entry.id,
                              })
                            }
                          >
                            {`${selectedSplit}点を${rosterLabel(entry.id, pinnedStaffId, roster)}にする`}
                          </s-button>
                        ))}
                        <s-button
                          disabled={disabled}
                          onClick={() =>
                            run({
                              type: "assign_partial",
                              lineUuid: line.uuid,
                              quantity: selectedSplit,
                              staffId: null,
                            })
                          }
                        >
                          {`${selectedSplit}点を未割当にする`}
                        </s-button>
                      </s-stack>
                    ) : line.quantityValid && line.quantity > 1 ? (
                      <s-text color="subdued">この明細は数量を分けられません。</s-text>
                    ) : null}
                    <s-button
                      tone="critical"
                      disabled={disabled}
                      onClick={() => run({ type: "remove_line", lineUuid: line.uuid })}
                    >
                      カートから外す
                    </s-button>
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}
