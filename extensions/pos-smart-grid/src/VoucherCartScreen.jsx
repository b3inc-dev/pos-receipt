/**
 * 会計の前に商品券の額面を入れる画面（「商品券釣銭登録」タイル、カートに商品があるとき）。
 * 入れた額面はカートの見えない項目に入り、会計後の画面で商品券調整として自動で登録される
 * （docs/VOUCHER_CART_ENTRY.md）。釣銭は会計のあと、商品券で払った額から出す。
 */
import { useEffect, useState } from "preact/hooks";
import {
  VOUCHER_CART_FACE_KEY,
  VOUCHER_CART_HINT_KEY,
  parseVoucherFaceInput,
  voucherFaceInCart,
} from "../../common/voucherCartEntry.js";
import { FixedFooterNavBar } from "./FixedFooterNavBar.jsx";
import { VoucherFaceCandidates } from "./VoucherFaceCandidates.jsx";
import { FormHeading, FormHero, FormLine, yen as yenStr } from "./AdjustFormParts.jsx";

function readCart() {
  try {
    return globalThis?.shopify?.cart?.current?.value ?? null;
  } catch (_) {
    return null;
  }
}

function dismiss() {
  try {
    globalThis?.shopify?.action?.dismissModal?.();
  } catch (_) {
    /* ignore */
  }
}

function toast(text) {
  try {
    globalThis?.shopify?.toast?.show?.(text);
  } catch (_) {
    /* ignore */
  }
}

const yen = (n) => `${Number(n ?? 0).toLocaleString("ja-JP")}円`;

export function VoucherCartScreen({ onOpenList }) {
  const [cart, setCart] = useState(readCart);
  const current = voucherFaceInCart(cart);
  const [input, setInput] = useState(current != null ? String(current) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let unsub = null;
    try {
      unsub = globalThis?.shopify?.cart?.current?.subscribe?.((c) => setCart(c));
    } catch (_) {
      /* ignore */
    }
    return () => {
      try {
        if (typeof unsub === "function") unsub();
      } catch (_) {
        /* ignore */
      }
    };
  }, []);

  const face = parseVoucherFaceInput(input);
  const total = Number(cart?.grandTotal ?? 0);

  const save = async () => {
    if (face == null) {
      setError("商品券の額面を数字で入れてください（例: 5000）");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await globalThis.shopify.cart.addCartProperties({ [VOUCHER_CART_FACE_KEY]: String(face) });
      try {
        await globalThis?.shopify?.storage?.set?.(VOUCHER_CART_HINT_KEY, { face, at: Date.now() });
      } catch (_) {
        /* 目印が書けなくても、注文更新の知らせで拾い直す */
      }
      toast(`商品券 ${yen(face)} を入れました`);
      dismiss();
    } catch (e) {
      setError("カートに入れられませんでした。もう一度押してください。");
      console.error("[VoucherCartScreen] addCartProperties", e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError("");
    try {
      await globalThis.shopify.cart.removeCartProperties([VOUCHER_CART_FACE_KEY]);
      try {
        await globalThis?.shopify?.storage?.delete?.(VOUCHER_CART_HINT_KEY);
      } catch (_) {
        /* ignore */
      }
      setInput("");
      toast("商品券の額面を外しました");
    } catch (e) {
      setError("外せませんでした。もう一度押してください。");
      console.error("[VoucherCartScreen] removeCartProperties", e);
    } finally {
      setSaving(false);
    }
  };

  // 入力の画面も注文の詳細と同じ形（T 2026-11-24）: 見出しで区切り「左に項目名・右に値」、釣銭の見込みは大きく。
  // 下は固定: 左に「戻る」、右に「カートに入れる」
  const estimatedChange = face != null && Number.isFinite(total) && total > 0 ? Math.max(0, face - total) : null;
  return (
    <s-page heading="会計前登録">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="none">
            {error ? <s-banner tone="critical">{error}</s-banner> : null}
            <s-text color="subdued">
              入れたあと、いつもどおり「商品券釣有り」で会計してください。会計が終わると、商品券の釣銭を自動で登録します。
            </s-text>

            <FormHeading>カート</FormHeading>
            {Number.isFinite(total) && total > 0 ? <FormLine label="カートの合計" value={yenStr(total)} strong /> : null}
            {current != null ? <FormLine label="いま入っている額面" value={yenStr(current)} /> : null}

            <FormHeading>商品券</FormHeading>
            <s-text-field
              label="商品券の額面（円）"
              value={input}
              type="number"
              onInput={(e) => setInput(e?.currentTarget?.value ?? "")}
              placeholder="例: 5000"
            />
            {/* 額面の候補: カートの合計より上の近い 100 円区切り 1 つ + 500 円区切り 2 つ（T 2026-11-24） */}
            {Number.isFinite(total) && total > 0 ? (
              <s-box paddingBlockStart="small">
                <VoucherFaceCandidates amount={total} selected={input} onPick={setInput} disabled={saving} />
              </s-box>
            ) : null}
            {estimatedChange != null ? (
              <s-box paddingBlockStart="base">
                <FormHero
                  label="釣銭の見込み（額面 − カートの合計）"
                  value={yenStr(estimatedChange)}
                  sub="商品券だけで払ったときの額です。登録する釣銭は、会計のあと商品券で払った額から出します。"
                />
              </s-box>
            ) : null}
            {current != null ? (
              <s-box paddingBlockStart="base">
                <s-stack direction="inline" justifyContent="end">
                  <s-button variant="secondary" tone="critical" onClick={remove} disabled={saving}>
                    額面を外す
                  </s-button>
                </s-stack>
              </s-box>
            ) : null}

            <FormHeading>会計のあとで登録する</FormHeading>
            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
              <s-text type="small" color="subdued">会計が終わった注文に、あとから登録します。</s-text>
              <s-button variant="secondary" onClick={onOpenList} disabled={saving}>注文一覧</s-button>
            </s-stack>
          </s-stack>
        </s-box>
      </s-scroll-box>
      <FixedFooterNavBar
        centerAlignWithButtons
        leftLabel="戻る"
        onLeft={dismiss}
        leftDisabled={saving}
        rightLabel={current != null ? "入れ直す" : "カートに入れる"}
        onRight={save}
        rightDisabled={saving || face == null}
        rightLoading={saving}
      />
    </s-page>
  );
}
