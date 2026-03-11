/**
 * 領収書モーダル
 * 要件書 §8, §23.3
 *
 * Steps:
 *   search   → 取引検索一覧
 *   form     → 宛名・但し書き入力
 *   preview  → 領収書プレビュー
 *   confirm  → 発行確認
 *   done     → 完了
 *   history  → 発行履歴
 */
import { render } from "preact";
import { useState, useCallback, useEffect } from "preact/hooks";
import { searchOrders, getOrder } from "../../common/orderPickerApi.js";
import { previewReceipt, issueReceipt, getReceiptHistory } from "../../common/receiptApi.js";

const STORAGE_KEY = "pos_receipt_order_id";

export default async () => {
  render(<ReceiptModal />, document.body);
};

// ── Root ──────────────────────────────────────────────────────────────────────
function ReceiptModal() {
  const [step, setStep] = useState("search");
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [recipientName, setRecipientName] = useState("");
  const [proviso, setProviso] = useState("お買上品代として");
  const [preview, setPreview] = useState(null);
  const [issuedReceipt, setIssuedReceipt] = useState(null);
  const [isReissue, setIsReissue] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 取引詳細画面から起動した場合
  useEffect(() => {
    const preId = sessionStorage.getItem(STORAGE_KEY);
    if (preId) {
      sessionStorage.removeItem(STORAGE_KEY);
      setLoading(true);
      getOrder(preId)
        .then((order) => { setSelectedOrder(order); setStep("form"); })
        .catch((e) => setError(e?.message ?? "取得に失敗しました"))
        .finally(() => setLoading(false));
    }
  }, []);

  const handleOrderSelect = useCallback(async (orderId) => {
    setLoading(true);
    setError("");
    try {
      const order = await getOrder(orderId);
      setSelectedOrder(order);
      setStep("form");
    } catch (e) {
      setError(e?.message ?? "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  const handlePreview = useCallback(async () => {
    if (!selectedOrder) return;
    setLoading(true);
    setError("");
    try {
      const res = await previewReceipt({
        orderId: selectedOrder.orderId,
        recipientName,
        proviso,
      });
      setPreview(res.preview);
      setStep("preview");
    } catch (e) {
      setError(e?.message ?? "プレビューの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedOrder, recipientName, proviso]);

  const handleIssue = useCallback(async () => {
    if (!selectedOrder) return;
    setLoading(true);
    setError("");
    try {
      const res = await issueReceipt({
        orderId: selectedOrder.orderId,
        recipientName,
        proviso,
        isReissue,
      });
      setIssuedReceipt(res.receipt);
      setStep("done");
    } catch (e) {
      setError(e?.message ?? "発行に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedOrder, recipientName, proviso, isReissue]);

  const goBack = useCallback(() => {
    setSelectedOrder(null);
    setPreview(null);
    setIssuedReceipt(null);
    setError("");
    setStep("search");
  }, []);

  if (step === "search") {
    return (
      <SearchView
        loading={loading}
        error={error}
        setError={setError}
        setLoading={setLoading}
        onSelect={handleOrderSelect}
        onHistory={() => setStep("history")}
      />
    );
  }

  if (step === "form") {
    return (
      <FormView
        order={selectedOrder}
        recipientName={recipientName}
        proviso={proviso}
        isReissue={isReissue}
        loading={loading}
        error={error}
        setRecipientName={setRecipientName}
        setProviso={setProviso}
        setIsReissue={setIsReissue}
        setError={setError}
        onPreview={handlePreview}
        onBack={goBack}
      />
    );
  }

  if (step === "preview") {
    return (
      <PreviewView
        preview={preview}
        isReissue={isReissue}
        loading={loading}
        error={error}
        onConfirm={() => setStep("confirm")}
        onEdit={() => setStep("form")}
        onBack={() => setStep("form")}
      />
    );
  }

  if (step === "confirm") {
    return (
      <ConfirmView
        preview={preview}
        isReissue={isReissue}
        loading={loading}
        error={error}
        onIssue={handleIssue}
        onBack={() => setStep("preview")}
      />
    );
  }

  if (step === "done") {
    return (
      <DoneView
        receipt={issuedReceipt}
        onClose={goBack}
        onReissue={() => {
          setIsReissue(true);
          setIssuedReceipt(null);
          setPreview(null);
          setStep("form");
        }}
      />
    );
  }

  if (step === "history") {
    return <HistoryView onBack={() => setStep("search")} />;
  }

  return null;
}

// ── 取引検索 ──────────────────────────────────────────────────────────────────
function SearchView({ loading, error, setError, setLoading, onSelect, onHistory }) {
  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);

  const onSearch = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const res = await searchOrders({ q: q.trim() || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined, limit: 20 });
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setError(e?.message ?? "検索に失敗しました");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [q, dateFrom, dateTo, setError, setLoading]);

  const onLoadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoading(true);
    try {
      const res = await searchOrders({ q: q.trim() || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined, cursor: nextCursor, limit: 20 });
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [q, dateFrom, dateTo, nextCursor, setLoading]);

  return (
    <s-page heading="取引を選択（領収書）">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text-field
              label="注文番号・顧客名"
              value={q}
              onInput={(e) => setQ(e?.currentTarget?.value ?? "")}
              placeholder="#1001 または 顧客名"
            />
            <s-text-field label="日付から" value={dateFrom} onInput={(e) => setDateFrom(e?.currentTarget?.value ?? "")} />
            <s-text-field label="日付まで" value={dateTo} onInput={(e) => setDateTo(e?.currentTarget?.value ?? "")} />
            <s-button kind="primary" onClick={onSearch} loading={loading}>検索</s-button>
            {error ? <s-text tone="critical">{error}</s-text> : null}
          </s-stack>
        </s-box>

        {items.length > 0 ? (
          <s-box padding="base">
            <s-text fontWeight="bold">検索結果 ({items.length}件)</s-text>
            <s-stack gap="small" paddingBlockStart="small">
              {items.map((order) => (
                <s-pressable key={order.orderId} onPress={() => onSelect(order.orderId)}>
                  <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                    <s-stack gap="extraSmall">
                      <s-text fontWeight="bold">{order.orderName}</s-text>
                      <s-text tone="subdued">{order.customerName || "顧客なし"} — ¥{Number(order.totalPrice).toLocaleString()}</s-text>
                      <s-text tone="subdued" fontSize="small">
                        {order.createdAt?.slice(0, 10)} {order.locationName ? `| ${order.locationName}` : ""}
                      </s-text>
                    </s-stack>
                  </s-box>
                </s-pressable>
              ))}
            </s-stack>
            {nextCursor ? (
              <s-box paddingBlockStart="base">
                <s-button kind="secondary" onClick={onLoadMore} loading={loading}>さらに読み込む</s-button>
              </s-box>
            ) : null}
          </s-box>
        ) : !loading && (q || dateFrom || dateTo) ? (
          <s-box padding="base"><s-text tone="subdued">該当する取引がありません。</s-text></s-box>
        ) : null}

        <s-box padding="base">
          <s-button kind="plain" onClick={onHistory}>発行履歴を見る</s-button>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

// ── 入力フォーム ──────────────────────────────────────────────────────────────
function FormView({
  order, recipientName, proviso, isReissue,
  loading, error,
  setRecipientName, setProviso, setIsReissue, setError,
  onPreview, onBack,
}) {
  const handleNext = () => {
    setError("");
    onPreview();
  };

  return (
    <s-page heading="領収書情報を入力">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            {/* 対象取引 */}
            <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="extraSmall">
                <s-text fontWeight="bold">{order?.orderName ?? "-"}</s-text>
                <s-text tone="subdued">
                  ¥{Number(order?.totalPrice?.amount ?? 0).toLocaleString()}
                  {order?.location?.name ? ` | ${order.location.name}` : ""}
                </s-text>
              </s-stack>
            </s-box>

            {/* 宛名 */}
            <s-text-field
              label="宛名"
              value={recipientName}
              onInput={(e) => setRecipientName(e?.currentTarget?.value ?? "")}
              placeholder="例: 株式会社○○ 御中"
            />

            {/* 但し書き */}
            <s-text-field
              label="但し書き"
              value={proviso}
              onInput={(e) => setProviso(e?.currentTarget?.value ?? "")}
              placeholder="例: お買上品代として"
            />

            {/* 再発行フラグ */}
            <s-stack direction="horizontal" align="space-between">
              <s-text>再発行として記録する</s-text>
              <s-checkbox
                checked={isReissue}
                onChange={(e) => setIsReissue(e?.currentTarget?.checked ?? isReissue)}
              />
            </s-stack>

            {error ? <s-text tone="critical">{error}</s-text> : null}

            <s-stack gap="small">
              <s-button kind="primary" onClick={handleNext} loading={loading}>プレビューを確認</s-button>
              <s-button kind="plain" onClick={onBack} disabled={loading}>← 取引検索に戻る</s-button>
            </s-stack>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

// ── プレビュー ────────────────────────────────────────────────────────────────
function PreviewView({ preview, isReissue, loading, error, onConfirm, onEdit, onBack }) {
  if (!preview) return null;

  return (
    <s-page heading={isReissue ? "領収書プレビュー（再発行）" : "領収書プレビュー"}>
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">

            {/* 領収書イメージ */}
            <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="small">
                <s-text fontWeight="bold" fontSize="large">領　収　書</s-text>
                {isReissue ? <s-text tone="critical" fontSize="small">【再発行】</s-text> : null}

                <s-stack direction="horizontal" align="space-between">
                  <s-text>{preview.recipientName ? `${preview.recipientName} 様` : "　　　　　 様"}</s-text>
                  {preview.showDate ? <s-text tone="subdued" fontSize="small">{preview.issueDate}</s-text> : null}
                </s-stack>

                <s-box paddingBlock="small" borderBlockStartWidth="base" borderColor="subdued">
                  <s-stack direction="horizontal" align="space-between">
                    <s-text>金額</s-text>
                    <s-text fontWeight="bold" fontSize="large">¥{Number(preview.amount).toLocaleString()}</s-text>
                  </s-stack>
                </s-box>

                <s-text tone="subdued" fontSize="small">但し {preview.proviso}</s-text>

                {preview.showOrderNumber ? (
                  <s-text tone="subdued" fontSize="small">注文番号: {preview.orderName}</s-text>
                ) : null}

                {preview.companyName ? (
                  <s-box paddingBlockStart="small" borderBlockStartWidth="base" borderColor="subdued">
                    <s-stack gap="extraSmall">
                      <s-text fontWeight="bold">{preview.companyName}</s-text>
                      {preview.address ? <s-text tone="subdued" fontSize="small">{preview.address}</s-text> : null}
                      {preview.phone ? <s-text tone="subdued" fontSize="small">TEL: {preview.phone}</s-text> : null}
                    </s-stack>
                  </s-box>
                ) : null}
              </s-stack>
            </s-box>

            {error ? <s-text tone="critical">{error}</s-text> : null}

            <s-stack gap="small">
              <s-button kind="primary" onClick={onConfirm} disabled={loading}>
                {isReissue ? "再発行する" : "発行する"}
              </s-button>
              <s-button kind="secondary" onClick={onEdit} disabled={loading}>内容を修正する</s-button>
              <s-button kind="plain" onClick={onBack} disabled={loading}>← 戻る</s-button>
            </s-stack>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

// ── 発行確認 ──────────────────────────────────────────────────────────────────
function ConfirmView({ preview, isReissue, loading, error, onIssue, onBack }) {
  return (
    <s-page heading="発行確認">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text fontWeight="bold">
              {isReissue ? "領収書を再発行します" : "領収書を発行します"}
            </s-text>

            <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="small">
                <Row label="宛名" value={preview?.recipientName || "（未入力）"} />
                <Row label="金額" value={`¥${Number(preview?.amount ?? 0).toLocaleString()}`} bold />
                <Row label="但し書き" value={preview?.proviso ?? ""} />
                <Row label="注文番号" value={preview?.orderName ?? ""} />
                <Row label="発行日" value={preview?.issueDate ?? ""} />
                {isReissue ? <s-text tone="critical" fontSize="small">※ 再発行として記録されます</s-text> : null}
              </s-stack>
            </s-box>

            {error ? <s-text tone="critical">{error}</s-text> : null}

            <s-stack gap="small">
              <s-button kind="primary" onClick={onIssue} loading={loading}>発行する</s-button>
              <s-button kind="secondary" onClick={onBack} disabled={loading}>戻る</s-button>
            </s-stack>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

// ── 完了 ──────────────────────────────────────────────────────────────────────
function DoneView({ receipt, onClose, onReissue }) {
  return (
    <s-page heading="発行完了">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text fontWeight="bold">
              {receipt?.isReissue ? "領収書を再発行しました" : "領収書を発行しました"}
            </s-text>

            <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="small">
                <s-text fontWeight="bold" fontSize="large">領　収　書</s-text>
                {receipt?.isReissue ? <s-text tone="critical" fontSize="small">【再発行】</s-text> : null}
                <Row label="宛名" value={receipt?.recipientName || "（未入力）"} />
                <Row label="金額" value={`¥${Number(receipt?.amount ?? 0).toLocaleString()}`} bold />
                <Row label="但し書き" value={receipt?.proviso ?? ""} />
                <Row label="注文番号" value={receipt?.orderName ?? ""} />
                <Row label="発行日" value={receipt?.issueDate ?? ""} />
                {receipt?.companyName ? <Row label="発行者" value={receipt.companyName} /> : null}
              </s-stack>
            </s-box>

            <s-text tone="subdued" fontSize="small">
              発行ID: …{receipt?.receiptIssueId?.slice(-8) ?? ""}
            </s-text>

            <s-stack gap="small">
              <s-button kind="secondary" onClick={onReissue}>同じ取引を再発行する</s-button>
              <s-button kind="plain" onClick={onClose}>閉じる</s-button>
            </s-stack>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

// ── 発行履歴 ──────────────────────────────────────────────────────────────────
function HistoryView({ onBack }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    getReceiptHistory({ limit: 20 })
      .then((res) => setItems(res.items ?? []))
      .catch((e) => setError(e?.message ?? "履歴の取得に失敗しました"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <s-page heading="領収書発行履歴">
      <s-scroll-box>
        <s-box padding="base">
          {loading ? (
            <s-text tone="subdued">読み込み中…</s-text>
          ) : error ? (
            <s-text tone="critical">{error}</s-text>
          ) : items.length === 0 ? (
            <s-text tone="subdued">発行履歴がありません。</s-text>
          ) : (
            <s-stack gap="small">
              {items.map((item) => (
                <s-box key={item.id} padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                  <s-stack gap="extraSmall">
                    <s-stack direction="horizontal" align="space-between">
                      <s-text fontWeight="bold">{item.orderName}</s-text>
                      <s-text fontWeight="bold">¥{Number(item.amount).toLocaleString()}</s-text>
                    </s-stack>
                    <s-text tone="subdued" fontSize="small">
                      宛名: {item.recipientName || "（未入力）"} {item.isReissue ? "【再発行】" : ""}
                    </s-text>
                    <s-text tone="subdued" fontSize="small">
                      {item.createdAt?.slice(0, 16).replace("T", " ")}
                    </s-text>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}
        </s-box>
        <s-box padding="base">
          <s-button kind="plain" onClick={onBack}>← 戻る</s-button>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

// ── ヘルパー ──────────────────────────────────────────────────────────────────
function Row({ label, value, bold = false }) {
  return (
    <s-stack direction="horizontal" align="space-between">
      <s-text tone="subdued" fontSize="small">{label}</s-text>
      <s-text fontWeight={bold ? "bold" : undefined}>{value}</s-text>
    </s-stack>
  );
}
