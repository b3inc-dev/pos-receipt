import { useEffect, useState } from "preact/hooks";
import { getOrder, getStaffAttribution, saveStaffAttribution } from "../../common/orderPickerApi.js";
import {
  attributionFromConfirmedLine,
  readLineQuantities,
} from "../../common/orderStaffAttribution.js";
import { parseStableStaffId } from "../../common/cartStaffAssignment.js";

const ERROR_TEXT = {
  staff_unverified: "担当IDを確認できないため、保存しませんでした。",
  quantity_invalid: "数量が明細と合いません。",
  quantity_mismatch: "指定した数量の合計が明細と合いません。",
  quantity_conflict: "保存済みの数量と明細の数量が違うため、保存しませんでした。",
  slices_required: "担当の追加順を指定してください。",
  line_missing: "対象の明細がありません。",
  idempotency_key_required: "訂正を識別できないため、保存しませんでした。",
  recorded_at_required: "訂正日時を記録できないため、保存しませんでした。",
  apply_failed: "担当の記録に失敗しました。",
  shop_record_missing: "店舗の記録が見つからないため、保存できませんでした。",
};

function errorText(code) {
  return ERROR_TEXT[code] ?? "担当の記録に失敗しました。";
}

function errorFromUnknown(error) {
  const message = error instanceof Error ? error.message : "";
  const code = message.split(" (HTTP")[0];
  return ERROR_TEXT[code] ?? (message || errorText("apply_failed"));
}

function readSession() {
  try {
    return shopify?.session?.currentSession ?? null;
  } catch {
    return null;
  }
}

function staffLabel(staffId, pinnedStaffId, knownStaffIds) {
  if (staffId == null) return "未割当";
  if (staffId === pinnedStaffId) return "ログイン中の担当";
  const others = [...(knownStaffIds ?? [])].filter((id) => id !== pinnedStaffId);
  if (others.length > 1) return `明細の担当 ${staffId}`;
  return "明細の担当";
}

function newKey() {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
  return `staff-${Date.now()}`;
}

function sliceSignature(slices) {
  return JSON.stringify(slices ?? []);
}

function appendPoint(slices, staffId) {
  const next = (slices ?? []).map((slice) => ({ ...slice }));
  const last = next[next.length - 1];
  if (last && last.staffId === staffId) {
    next[next.length - 1] = { ...last, quantity: last.quantity + 1 };
  } else {
    next.push({ staffId, quantity: 1 });
  }
  return next;
}

function removePoint(slices) {
  const next = (slices ?? []).map((slice) => ({ ...slice }));
  const last = next[next.length - 1];
  if (!last) return next;
  if (last.quantity <= 1) next.pop();
  else next[next.length - 1] = { ...last, quantity: last.quantity - 1 };
  return next;
}

function sumQuantity(slices) {
  return (slices ?? []).reduce((sum, slice) => sum + (slice.quantity ?? 0), 0);
}

export function OrderStaffCorrection({ orderId, onBack }) {
  const [order, setOrder] = useState(null);
  const [savedLines, setSavedLines] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [attempts, setAttempts] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyLine, setBusyLine] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pinnedStaffId = parseStableStaffId(readSession()?.staffMemberId);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const orderResult = await getOrder(orderId);
      let savedResult = null;
      try {
        savedResult = await getStaffAttribution(orderId);
      } catch {
        savedResult = null;
      }
      setOrder(orderResult);
      setSavedLines(savedResult && Array.isArray(savedResult.lines) ? savedResult.lines : []);
    } catch (loadError) {
      setError(errorFromUnknown(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (orderId) load();
  }, [orderId]);

  const savedByLine = new Map((savedLines ?? []).map((line) => [line.lineId, line]));
  const knownStaffIds = new Set();
  if (pinnedStaffId) knownStaffIds.add(pinnedStaffId);
  for (const saved of savedLines ?? []) {
    for (const slice of saved.slices ?? []) {
      if (typeof slice.staffId === "number") knownStaffIds.add(slice.staffId);
    }
  }

  const changeDraft = (lineId, currentSlices, next) => {
    setDrafts((prev) => ({ ...prev, [lineId]: next }));
    setNotice("");
    if (sliceSignature(currentSlices) !== sliceSignature(next)) {
      setAttempts((prev) => ({ ...prev, [lineId]: null }));
    }
  };

  const saveLine = async (line, draft) => {
    const quantities = readLineQuantities(line);
    const signature = sliceSignature(draft);
    const previousAttempt = attempts[line.id];
    const idempotencyKey = previousAttempt?.signature === signature
      ? previousAttempt.key
      : newKey();
    setAttempts((prev) => ({ ...prev, [line.id]: { key: idempotencyKey, signature } }));
    setBusyLine(line.id);
    setError("");
    setNotice("");
    try {
      const result = await saveStaffAttribution(orderId, {
        idempotencyKey,
        lineId: line.id,
        quantity: quantities.quantity,
        returnedQuantity: quantities.returnedQuantity,
        recordedAt: new Date().toISOString(),
        slices: draft,
      });
      if (!result?.ok) {
        setError(errorText(result?.error));
        return;
      }
      setNotice(result.duplicate ? "同じ訂正はすでに記録されています。" : "担当順を記録しました。決済、返金、在庫は変えていません。");
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[line.id];
        return next;
      });
      await load();
    } catch (saveError) {
      setError(errorFromUnknown(saveError));
    } finally {
      setBusyLine("");
    }
  };

  return (
    <s-page heading="確定済みの担当">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            {onBack ? <s-button onClick={onBack}>取引履歴へ戻る</s-button> : null}
            <s-text color="subdued">
              訂正は記録だけです。決済、返金、在庫は変わりません。
            </s-text>
            {loading ? <s-text>取引を読み込んでいます。</s-text> : null}
            {error ? <s-text tone="critical">{error}</s-text> : null}
            {notice ? <s-text>{notice}</s-text> : null}
            {order ? <s-text type="strong">{order.orderName ?? "取引"}</s-text> : null}
            {(order?.lineItems ?? []).map((line) => {
              const saved = savedByLine.get(line.id) ?? null;
              const view = attributionFromConfirmedLine(line, saved);
              if (!view) return null;
              const draft = drafts[line.id] ?? (view.sequenceKnown
                ? view.slices.map((slice) => ({ staffId: slice.staffId, quantity: slice.quantity }))
                : []);
              const assigned = sumQuantity(draft);
              const remaining = view.quantity - assigned;
              const preview = remaining === 0 && draft.length > 0
                ? attributionFromConfirmedLine(line, {
                  sequenceKnown: true,
                  quantity: view.quantity,
                  slices: draft,
                })
                : null;
              return (
                <s-box key={line.id} padding="small">
                  <s-stack gap="base">
                    <s-text type="strong">{`${line.title ?? "商品"} × ${view.quantity}`}</s-text>
                    {view.returnedQuantity == null ? (
                      <s-text color="subdued">返品数は未確認です。</s-text>
                    ) : (
                      <s-text color="subdued">{`返品 ${view.returnedQuantity}点`}</s-text>
                    )}
                    {view.sequenceKnown ? (
                      view.slices.map((slice) => (
                        <s-text key={`${line.id}-saved-${slice.sequence}`}>
                          {`${slice.sequence}. ${staffLabel(slice.staffId, pinnedStaffId, knownStaffIds)} ${slice.quantity}点`}
                          {slice.returnedQuantity == null
                            ? ""
                            : ` / 返品 ${slice.returnedQuantity}点 / 残 ${slice.remainingQuantity}点`}
                        </s-text>
                      ))
                    ) : (
                      <s-text color="subdued">
                        担当の追加順は記録されていません。表示名からは推測せず、追加した順に指定してください。
                      </s-text>
                    )}
                    <s-text>{`指定 ${assigned}点 / 残り ${remaining}点`}</s-text>
                    {(draft ?? []).map((slice, index) => (
                      <s-text key={`${line.id}-draft-${index}`}>
                        {`${index + 1}. ${staffLabel(slice.staffId, pinnedStaffId, knownStaffIds)} ${slice.quantity}点`}
                      </s-text>
                    ))}
                    {[...knownStaffIds].map((staffId) => (
                      <s-button
                        key={`${line.id}-add-${staffId}`}
                        disabled={busyLine === line.id || remaining <= 0}
                        onClick={() => changeDraft(line.id, draft, appendPoint(draft, staffId))}
                      >
                        {`${staffLabel(staffId, pinnedStaffId, knownStaffIds)}を1点追加`}
                      </s-button>
                    ))}
                    <s-button
                      disabled={busyLine === line.id || remaining <= 0}
                      onClick={() => changeDraft(line.id, draft, appendPoint(draft, null))}
                    >
                      未割当を1点追加
                    </s-button>
                    <s-button
                      disabled={busyLine === line.id || draft.length === 0}
                      onClick={() => changeDraft(line.id, draft, removePoint(draft))}
                    >
                      直前の1点を戻す
                    </s-button>
                    {preview?.sequenceKnown ? (
                      <s-text color="subdued">
                        {preview.returnAllocations.length === 0
                          ? "この順では返品の担当はありません。"
                          : `返品の帰属: ${preview.returnAllocations.map((item) => `${item.sequence}番目 ${item.quantity}点`).join("、")}`}
                      </s-text>
                    ) : null}
                    <s-button
                      disabled={busyLine === line.id || remaining !== 0 || draft.length === 0}
                      onClick={() => saveLine(line, draft)}
                    >
                      この順を記録する
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
