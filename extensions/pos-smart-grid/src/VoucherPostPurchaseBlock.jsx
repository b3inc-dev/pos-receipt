/**
 * 会計後の画面の枠（pos.purchase.post.block.render）。
 * この端末で会計の前に商品券の額面を入れていたら、その注文に商品券調整を自動で登録して、結果を一行で出す。
 * 額面を入れていない会計では何も出さない（サーバーも呼ばない）。
 * ここで登録できなかったときも、注文更新の知らせで拾い直す（docs/VOUCHER_CART_ENTRY.md）。
 */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { registerVoucherFromCart } from "../../common/specialRefundApi.js";
import { VOUCHER_CART_HINT_KEY, isHintFresh, postPurchaseMessage } from "../../common/voucherCartEntry.js";

export default async () => {
  render(<VoucherPostPurchaseBlock />, document.body);
};

async function readHint() {
  try {
    return (await globalThis?.shopify?.storage?.get?.(VOUCHER_CART_HINT_KEY)) ?? null;
  } catch (_) {
    return null;
  }
}

async function clearHint() {
  try {
    await globalThis?.shopify?.storage?.delete?.(VOUCHER_CART_HINT_KEY);
  } catch (_) {
    /* ignore */
  }
}

function VoucherPostPurchaseBlock() {
  const [message, setMessage] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const hint = await readHint();
      if (!hint) return;
      if (!isHintFresh(hint)) {
        await clearHint();
        return;
      }
      const orderId = globalThis?.shopify?.order?.id;
      if (orderId == null) return;
      if (alive) setMessage({ tone: "subdued", text: "商品券を登録しています…" });
      try {
        const res = await registerVoucherFromCart({ sourceOrderId: String(orderId) });
        // 結果が出たら目印を消す（この注文に額面が無かったときも、次の会計に持ち越さない）
        await clearHint();
        if (alive) setMessage(postPurchaseMessage(res));
      } catch (e) {
        console.error("[VoucherPostPurchaseBlock]", e);
        if (alive) {
          setMessage({ tone: "critical", text: "商品券を登録できませんでした。あとで「商品券」タイルから確かめてください" });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!message) return null;
  return (
    <s-pos-block heading="商品券">
      <s-box padding="small">
        <s-text tone={message.tone === "subdued" ? "neutral" : message.tone}>{message.text}</s-text>
      </s-box>
    </s-pos-block>
  );
}
