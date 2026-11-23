/**
 * 商品券タイル（POS ホーム）: 会計前の額面入力・後からの釣銭調整
 * 取引詳細メニュー・会計後の枠と同じ拡張に home.tile が必要（領収書・特殊返金と同じ構成）
 * カートに額面が入っていれば、サブタイトルでわかるようにする
 */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { voucherFaceInCart } from "../../common/voucherCartEntry.js";

export default async () => {
  render(<VoucherTile />, document.body);
};

function readFace() {
  try {
    return voucherFaceInCart(globalThis?.shopify?.cart?.current?.value);
  } catch (_) {
    return null;
  }
}

function VoucherTile() {
  const [face, setFace] = useState(readFace);
  useEffect(() => {
    let unsub = null;
    try {
      unsub = globalThis?.shopify?.cart?.current?.subscribe?.((c) => setFace(voucherFaceInCart(c)));
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
  return (
    <s-tile
      heading="商品券釣銭調整"
      subheading={face != null ? `額面 ${Number(face).toLocaleString("ja-JP")}円 入力済み` : "商品券釣銭調整処理・履歴一覧"}
      onClick={() => shopify.action.presentModal()}
    />
  );
}
