/**
 * 会計の前に商品券の額面を入れる画面（「商品券」タイル、カートに商品があるとき）。
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

  return (
    <s-page heading="商品券">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            {error ? <s-banner tone="critical">{error}</s-banner> : null}
            <s-section heading="会計の前に額面を入れる">
              <s-stack gap="small">
                <s-text tone="subdued">
                  入れたあと、いつもどおり「商品券釣有り」で会計してください。会計が終わると、商品券の釣銭を自動で登録します。
                </s-text>
                {Number.isFinite(total) && total > 0 ? (
                  <s-stack direction="inline" justifyContent="space-between">
                    <s-text tone="subdued">カートの合計</s-text>
                    <s-text>{yen(total)}</s-text>
                  </s-stack>
                ) : null}
                {current != null ? (
                  <s-stack direction="inline" justifyContent="space-between">
                    <s-text tone="subdued">いま入っている額面</s-text>
                    <s-badge tone="info">{yen(current)}</s-badge>
                  </s-stack>
                ) : null}
                <s-text-field
                  label="商品券の額面（円）"
                  value={input}
                  type="number"
                  onInput={(e) => setInput(e?.currentTarget?.value ?? "")}
                  placeholder="例: 5000"
                />
                <s-button variant="primary" onClick={save} disabled={saving || face == null}>
                  {current != null ? "額面を入れ直す" : "カートに入れる"}
                </s-button>
                {current != null ? (
                  <s-button tone="critical" onClick={remove} disabled={saving}>
                    額面を外す
                  </s-button>
                ) : null}
              </s-stack>
            </s-section>
            <s-section heading="会計のあとで登録する">
              <s-stack gap="small">
                <s-text tone="subdued">会計が終わった注文に、あとから商品券の額面を登録します。</s-text>
                <s-button onClick={onOpenList} disabled={saving}>注文の一覧を開く</s-button>
              </s-stack>
            </s-section>
          </s-stack>
        </s-box>
      </s-scroll-box>
      <FixedFooterNavBar leftLabel="戻る" onLeft={dismiss} centerAlignWithButtons />
    </s-page>
  );
}
