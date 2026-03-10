import { render } from "preact";
import { useState, useCallback, useEffect } from "preact/hooks";
import { searchOrders, getOrder } from "../../common/orderPickerApi.js";

const STORAGE_KEY = "pos_receipt_pre_selected_order_id";

export default async () => {
  render(<OrderPickerModal />, document.body);
};

function OrderPickerModal() {
  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);

  // 取引詳細画面から起動した場合: 保存された orderId で注文を取得
  useEffect(() => {
    const preId = sessionStorage.getItem(STORAGE_KEY);
    if (preId) {
      sessionStorage.removeItem(STORAGE_KEY);
      setLoading(true);
      getOrder(preId)
        .then((order) => setSelected(order))
        .catch((e) => setError(e?.message ?? "取得に失敗しました"))
        .finally(() => setLoading(false));
    }
  }, []);

  const onSearch = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const res = await searchOrders({
        q: q.trim() || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        limit: 20,
      });
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setError(e?.message ?? "検索に失敗しました");
      setItems([]);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  }, [q, dateFrom, dateTo]);

  const onSelectOrder = useCallback(async (orderId) => {
    setError("");
    setLoading(true);
    try {
      const order = await getOrder(orderId);
      setSelected(order);
    } catch (e) {
      setError(e?.message ?? "取得に失敗しました");
      setSelected(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const clearSelection = useCallback(() => {
    setSelected(null);
  }, []);

  if (selected) {
    return (
      <s-page heading="取引を選択">
        <s-scroll-box>
          <s-box padding="base">
            <s-text fontWeight="bold">選択した取引</s-text>
            <s-text>{selected.orderName ?? selected.name}</s-text>
            <s-text tone="subdued">顧客: {selected.customer?.displayName ?? "-"}</s-text>
            <s-text tone="subdued">合計: {selected.totalPrice?.amount ?? "-"} {selected.totalPrice?.currencyCode ?? ""}</s-text>
            <s-box paddingBlockStart="base">
              <s-button kind="secondary" onClick={clearSelection}>別の取引を選ぶ</s-button>
            </s-box>
            <s-text tone="subdued" fontSize="small">（このあと特殊返金・領収書などに進みます）</s-text>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  return (
    <s-page heading="取引検索">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text-field
              label="注文番号・顧客名"
              value={q}
              onInput={(e) => setQ(e?.currentTarget?.value ?? e?.currentValue?.value ?? "")}
              placeholder="#1001 または 顧客名"
            />
            <s-text-field
              label="日付から (YYYY-MM-DD)"
              value={dateFrom}
              onInput={(e) => setDateFrom(e?.currentTarget?.value ?? e?.currentValue?.value ?? "")}
            />
            <s-text-field
              label="日付まで (YYYY-MM-DD)"
              value={dateTo}
              onInput={(e) => setDateTo(e?.currentTarget?.value ?? e?.currentValue?.value ?? "")}
            />
            <s-button kind="primary" onClick={onSearch} loading={loading}>
              検索
            </s-button>
            {error ? <s-text tone="critical">{error}</s-text> : null}
          </s-stack>
        </s-box>
        {items.length > 0 ? (
          <s-box padding="base">
            <s-text fontWeight="bold">検索結果 ({items.length}件)</s-text>
            <s-stack gap="small" paddingBlockStart="small">
              {items.map((order) => (
                <s-card key={order.orderId}>
                  <s-button
                    kind="secondary"
                    onClick={() => onSelectOrder(order.orderId)}
                    disabled={loading}
                  >
                    {order.orderName} — {order.customerName || "-"} — {order.totalPrice}円
                  </s-button>
                </s-card>
              ))}
            </s-stack>
            {nextCursor ? (
              <s-button kind="secondary" onClick={async () => {
                setLoading(true);
                try {
                  const res = await searchOrders({ q: q.trim() || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined, cursor: nextCursor, limit: 20 });
                  setItems((prev) => [...prev, ...res.items]);
                  setNextCursor(res.nextCursor);
                } finally {
                  setLoading(false);
                }
              }}>
                さらに読み込む
              </s-button>
            ) : null}
          </s-box>
        ) : !loading && (q || dateFrom || dateTo) ? (
          <s-box padding="base">
            <s-text tone="subdued">該当する取引がありません。</s-text>
          </s-box>
        ) : null}
      </s-scroll-box>
    </s-page>
  );
}
