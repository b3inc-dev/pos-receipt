/**
 * 返品・交換が終わった画面の枠（pos.return.post.block.render / pos.exchange.post.block.render）。
 * その注文に返金の予約があれば、GET /api/refund-reservations で純正の返金に当てて（付け替えを作って）、結果を一行で出す。
 * 予約の無い注文では何も出さない。注文更新の知らせが届かない・遅いときでも、その場で付け替わる（docs/REFUND_RESERVATION.md）。
 */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { listRefundReservations } from "../../common/specialRefundApi.js";
import { postReturnMessage } from "../../common/refundReservation.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async () => {
  render(<RefundReservationPostReturnBlock />, document.body);
};

function RefundReservationPostReturnBlock() {
  const [message, setMessage] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const orderId = globalThis?.shopify?.order?.id;
      if (orderId == null) return;
      try {
        let res = await listRefundReservations(String(orderId));
        if (res?.enabled === false) return;
        // 返金の直後は Shopify の返金がまだ読めないことがあるので、使う前のままなら少し待って 2 回まで読み直す
        for (let i = 0; i < 2 && postReturnMessage(res?.items)?.tone === "neutral"; i++) {
          await sleep(3000);
          if (!alive) return;
          res = await listRefundReservations(String(orderId));
        }
        if (alive) setMessage(postReturnMessage(res?.items));
      } catch (e) {
        console.error("[RefundReservationPostReturnBlock]", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!message) return null;
  return (
    <s-pos-block heading="返金">
      <s-box padding="small">
        <s-text tone={message.tone}>{message.text}</s-text>
      </s-box>
    </s-pos-block>
  );
}
