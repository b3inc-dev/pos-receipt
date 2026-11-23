/**
 * 注文の詳細の「会計をやり直す」（キャンセル・返金済みの注文向け）
 *
 * 管理画面の「会計やり直しの方法」で出すボタンが変わる。
 * - カートに入れる: 同じ商品・お客様・割引を POS のカートに入れ、そのままお会計する
 * - 下書き注文を作成: 同じ商品で下書き注文を作る
 *
 * どちらも、確認・途中・結果をこの欄の中に同じ形で出す（T 2026-11-24: 下書きの結果が画面の上に
 * 離れて出ていたのと、確認の窓のタイトルが「確かめ」だけだったのを直す）。
 * 確認の見出しは処理名（「カートに入れる」「下書き注文を作成」）、ボタンは「入れる」「作成する」「やめる」。
 *
 * POS に無い部品（s-select など）と、効かない属性（fontWeight・size・kind）は使わない。
 */
import { useState, useCallback } from "preact/hooks";
import { getRedoCartPlan, createRedoDraft } from "../../common/orderPickerApi.js";
import {
  applyRedoCartPlan,
  checkCartReady,
  closeModalToPos,
  CART_NOT_READY_MESSAGES,
} from "../../common/redoToCart.js";
import { toUserMessage } from "../../common/errorMessage.js";

function formatYen(amount) {
  const n = Number(amount ?? 0);
  return `¥${(Number.isFinite(n) ? n : 0).toLocaleString()}`;
}

/** 英語の中のエラー（例: "x is not a function"）は店の画面に出さない */
function shopMessage(raw, fallback) {
  const msg = toUserMessage(raw);
  return msg && /[ぁ-んァ-ヶ一-龠]/.test(msg) ? msg : fallback;
}

function planNotes(plan) {
  const out = [];
  for (const w of plan?.warnings ?? []) {
    if (w.code === "deleted_product") {
      out.push(`「${w.title}」は削除された商品のため、同じ名前・値段のカスタム商品で入れます（在庫は動きません）。`);
    } else if (w.code === "price_lower_now") {
      out.push(`「${w.title}」は今の値段のほうが ${formatYen(w.difference)} 安いため、今の値段で入れます。`);
    }
  }
  return out;
}

function orderQuantity(order) {
  const items = order?.lineItems ?? [];
  return items.reduce((s, li) => s + Math.max(0, Number(li?.quantity ?? 0)), 0);
}

export function RedoCheckoutSection({ order, canRedoToCart, canRedoAsDraft, busy }) {
  // mode: cart / draft。phase: idle → confirm → running → done / idle（失敗は message で出す）
  const [mode, setMode] = useState("cart");
  const [phase, setPhase] = useState("idle");
  const [plan, setPlan] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState("");

  const cart = globalThis?.shopify?.cart;
  const orderId = order?.orderId;

  const handleStart = useCallback(async () => {
    setMode("cart");
    setMessage("");
    setResult(null);
    const ready = checkCartReady(cart);
    if (!ready.ok) {
      setMessage(CART_NOT_READY_MESSAGES[ready.reason] ?? CART_NOT_READY_MESSAGES.no_cart_api);
      return;
    }
    setPhase("running");
    setProgress({ done: 0, total: 0 });
    try {
      const res = await getRedoCartPlan(orderId);
      setPlan(res.plan ?? null);
      setPhase("confirm");
    } catch (e) {
      setMessage(shopMessage(e?.message, "注文を読み込めませんでした。しばらくしてから、もう一度押してください。"));
      setPhase("idle");
    }
  }, [cart, orderId]);

  const handleAdd = useCallback(async () => {
    if (!plan) return;
    setMessage("");
    setPhase("running");
    setProgress({ done: 0, total: plan.lines?.length ?? 0 });
    try {
      const res = await applyRedoCartPlan(cart, plan, (done, total) => setProgress({ done, total }));
      if (!res.ok) {
        if (res.reason === "nothing_added") {
          setMessage("カートに入れられた商品がありませんでした。在庫と商品を確かめてください。");
        } else {
          setMessage(CART_NOT_READY_MESSAGES[res.reason] ?? "カートに入れられませんでした。");
        }
        setPhase("idle");
        return;
      }
      setResult(res);
      setPhase("done");
    } catch (_) {
      setMessage("カートに入れる途中で止まりました。カートの中身を確かめてください。");
      setPhase("idle");
    }
  }, [cart, plan]);

  const handleDraftStart = useCallback(() => {
    setMode("draft");
    setMessage("");
    setResult(null);
    setPhase("confirm");
  }, []);

  const handleDraftCreate = useCallback(async () => {
    setMessage("");
    setPhase("running");
    try {
      const res = await createRedoDraft(orderId);
      setResult({
        draftName: res.draftOrder?.name ?? "",
        lineItemCount: res.draftOrder?.lineItemCount ?? 0,
      });
      setPhase("done");
    } catch (e) {
      setMessage(shopMessage(e?.message, "下書き注文を作成できませんでした。しばらくしてから、もう一度押してください。"));
      setPhase("idle");
    }
  }, [orderId]);

  const cancel = useCallback(() => {
    setPhase("idle");
    setPlan(null);
  }, []);

  if (!canRedoToCart && !canRedoAsDraft) return null;

  const disabled = Boolean(busy) || phase === "running";
  const qtyTotal = (plan?.lines ?? []).reduce((s, l) => s + Number(l.quantity ?? 0), 0);
  const orderName = plan?.orderName || order?.orderName || "この注文";
  const draftQty = orderQuantity(order);

  let description = "キャンセル・返金済みの注文と同じ商品で、もう一度お会計します。";
  if (canRedoToCart && canRedoAsDraft) {
    description += "POS でそのまま会計するときは「カートに入れる」、管理画面で会計するときは「下書き注文を作成」を押してください。";
  } else if (canRedoToCart) {
    description += "同じ商品・お客様・割引を POS のカートに入れます。";
  } else {
    description += "下書き注文を作ります。お会計は POS か管理画面でします。";
  }

  return (
    <s-box paddingBlockStart="base">
      <s-stack gap="small-300">
        <s-text type="small" color="subdued">会計をやり直す</s-text>

        {phase === "confirm" && mode === "cart" && plan ? (
          <s-stack gap="small-300">
            <s-text type="strong">カートに入れる</s-text>
            <s-text type="small">
              {orderName} と同じ商品 {qtyTotal} 点をカートに入れます。見込みの合計は {formatYen(plan.expectedTotal)} です。
            </s-text>
            <s-text type="small" color="subdued">元の注文の返金・キャンセルはそのままです。</s-text>
            {planNotes(plan).map((t) => (
              <s-text key={t} type="small" tone="caution">{t}</s-text>
            ))}
            <s-box paddingBlockStart="small-300">
              <s-stack direction="inline" gap="small">
                <s-button variant="secondary" onClick={cancel}>
                  やめる
                </s-button>
                <s-button variant="primary" onClick={handleAdd} disabled={disabled}>
                  入れる
                </s-button>
              </s-stack>
            </s-box>
          </s-stack>
        ) : phase === "confirm" && mode === "draft" ? (
          <s-stack gap="small-300">
            <s-text type="strong">下書き注文を作成</s-text>
            <s-text type="small">
              {orderName} と同じ商品{draftQty > 0 ? ` ${draftQty} 点` : ""}で下書き注文を作ります。お会計は POS の「下書き注文」か管理画面でします。
            </s-text>
            <s-text type="small" color="subdued">元の注文の返金・キャンセルはそのままです。</s-text>
            <s-box paddingBlockStart="small-300">
              <s-stack direction="inline" gap="small">
                <s-button variant="secondary" onClick={cancel}>
                  やめる
                </s-button>
                <s-button variant="primary" onClick={handleDraftCreate} disabled={disabled}>
                  作成する
                </s-button>
              </s-stack>
            </s-box>
          </s-stack>
        ) : phase === "done" && mode === "cart" && result ? (
          <s-stack gap="small-300">
            <s-text type="strong" tone="success">カートに入れました（{result.addedCount} 品目）</s-text>
            {result.skipped.length > 0 ? (
              <s-text type="small" tone="caution">入れなかった商品: {result.skipped.join("、")}</s-text>
            ) : null}
            {result.failed.length > 0 ? (
              <s-text type="small" tone="critical">入れられなかった商品: {result.failed.join("、")}</s-text>
            ) : null}
            {result.notes.map((t) => (
              <s-text key={t} type="small" tone="caution">{t}</s-text>
            ))}
            <s-text type="small" color="subdued">この画面を閉じて、POS のカートからお会計してください。</s-text>
            <s-box paddingBlockStart="small-300">
              <s-stack direction="inline" gap="small">
                <s-button variant="primary" onClick={() => closeModalToPos()}>
                  閉じる
                </s-button>
              </s-stack>
            </s-box>
          </s-stack>
        ) : phase === "done" && mode === "draft" && result ? (
          <s-stack gap="small-300">
            <s-text type="strong" tone="success">
              下書き注文{result.draftName ? ` ${result.draftName}` : ""} を作成しました（{result.lineItemCount} 品目）
            </s-text>
            <s-text type="small" color="subdued">
              この画面を閉じて、POS の「下書き注文」か管理画面からお会計してください。
            </s-text>
            <s-box paddingBlockStart="small-300">
              <s-stack direction="inline" gap="small">
                <s-button variant="primary" onClick={() => closeModalToPos()}>
                  閉じる
                </s-button>
              </s-stack>
            </s-box>
          </s-stack>
        ) : (
          <s-stack gap="small-300">
            <s-text type="small" color="subdued">{description}</s-text>
            {phase === "running" ? (
              <s-text type="small">
                {mode === "draft"
                  ? "下書き注文を作成しています…"
                  : progress.total > 0
                    ? `カートに入れています（${progress.done} / ${progress.total}）`
                    : "注文を読み込んでいます…"}
              </s-text>
            ) : null}
            <s-box paddingBlockStart="small-300">
              <s-stack direction="inline" gap="small">
                {canRedoToCart ? (
                  <s-button
                    variant="primary"
                    onClick={handleStart}
                    disabled={disabled}
                    loading={phase === "running" && mode === "cart"}
                  >
                    カートに入れる
                  </s-button>
                ) : null}
                {canRedoAsDraft ? (
                  <s-button
                    variant="secondary"
                    onClick={handleDraftStart}
                    disabled={disabled}
                    loading={phase === "running" && mode === "draft"}
                  >
                    下書き注文を作成
                  </s-button>
                ) : null}
              </s-stack>
            </s-box>
          </s-stack>
        )}

        {message ? <s-text type="small" tone="critical">{message}</s-text> : null}
      </s-stack>
    </s-box>
  );
}
