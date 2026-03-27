/**
 * ロケーション名＋年・月・日（ボタン）ヘッダーと、その日の取引一覧。
 * 領収書タイル・返金/商品券タイルで共有。
 */
import { useState, useEffect, useCallback, useMemo } from "preact/hooks";
import { searchOrders } from "../../common/orderPickerApi.js";
import { getLocationsFromShopify } from "../../common/shopifyAdminGraphql.js";
import { useSessionLocation } from "../../common/sessionLocation.js";
import { toUserMessage } from "../../common/errorMessage.js";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function todayYmd() {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1, day: d.getDate() };
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function ymdToStr(y, m, day) {
  return `${y}-${pad2(m)}-${pad2(day)}`;
}

/**
 * @param {object} item - searchOrders の1件
 * @param {"receipt" | "specialRefund"} badgeMode
 * @returns {string[]}
 */
export function formatPosBadgeLabels(item, badgeMode) {
  const b = item?.posBadges ?? {};
  const out = [];
  if (badgeMode === "receipt") {
    if (b.receiptIssued) out.push("領収書発行済");
    if (b.refundedShopify) out.push("返金");
    if (b.voucherLikeGateway) out.push("商品券決済");
  } else {
    if (b.hasSpecialRefund) out.push("特殊返金あり");
    if (b.hasVoucherAdjustment) out.push("商品券調整あり");
    if (b.refundedShopify) out.push("返金");
    if (b.voucherLikeGateway) out.push("商品券決済");
  }
  return out;
}

/**
 * @param {object} props
 * @param {string} props.pageHeading - s-page heading
 * @param {"receipt" | "specialRefund"} props.badgeMode
 * @param {(orderId: string) => void} props.onSelectOrderId
 * @param {import("preact").ComponentChildren} [props.headerTrailing] - ヘッダー右寄せの横に並べる操作（例: 履歴）
 * @param {string} [props.noticeError] - 一覧上部に出す一時メッセージ（取引詳細からの起動失敗など）
 * @param {() => void} [props.onDismissNotice]
 */
export function OrderDayListScreen({
  pageHeading,
  badgeMode,
  onSelectOrderId,
  headerTrailing = null,
  noticeError = "",
  onDismissNotice = () => {},
}) {
  const t0 = useMemo(() => todayYmd(), []);
  const { locationGid, locationIdParam, isReady: sessionReady } = useSessionLocation();

  const [selectedYear, setSelectedYear] = useState(t0.y);
  const [selectedMonth, setSelectedMonth] = useState(t0.m);
  const [selectedDay, setSelectedDay] = useState(t0.day);
  const [yearMenuOpen, setYearMenuOpen] = useState(false);
  const [monthMenuOpen, setMonthMenuOpen] = useState(false);
  const [dayMenuOpen, setDayMenuOpen] = useState(false);

  const [locationName, setLocationName] = useState("");
  const [locLoadError, setLocLoadError] = useState("");

  const [items, setItems] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const availableYears = useMemo(() => {
    return [t0.y, t0.y - 1, t0.y - 2];
  }, [t0.y]);

  const availableMonths = useMemo(() => {
    if (selectedYear < t0.y) {
      return Array.from({ length: 12 }, (_, i) => i + 1);
    }
    if (selectedYear > t0.y) return [];
    return Array.from({ length: t0.m }, (_, i) => i + 1);
  }, [selectedYear, t0.y, t0.m]);

  const maxDayForSelection = useMemo(() => {
    const dim = daysInMonth(selectedYear, selectedMonth);
    if (selectedYear === t0.y && selectedMonth === t0.m) {
      return Math.min(dim, t0.day);
    }
    return dim;
  }, [selectedYear, selectedMonth, t0.y, t0.m, t0.day]);

  const availableDays = useMemo(() => {
    return Array.from({ length: maxDayForSelection }, (_, i) => i + 1);
  }, [maxDayForSelection]);

  const dateStr = ymdToStr(selectedYear, selectedMonth, Math.min(selectedDay, maxDayForSelection));

  useEffect(() => {
    if (!sessionReady) return;
    if (!locationGid) {
      setLocationName("");
      return;
    }
    getLocationsFromShopify(80)
      .then((res) => {
        const locs = res.locations ?? [];
        const hit = locs.find((l) => l.locationId === locationGid || String(l.locationId).endsWith(locationIdParam ?? ""));
        setLocationName(hit?.locationName ?? "この店舗");
        setLocLoadError("");
      })
      .catch(() => {
        setLocationName(locationIdParam ? `店舗 #${locationIdParam}` : "この店舗");
        setLocLoadError("");
      });
  }, [sessionReady, locationGid, locationIdParam]);

  useEffect(() => {
    if (selectedMonth > 0 && !availableMonths.includes(selectedMonth)) {
      setSelectedMonth(availableMonths[availableMonths.length - 1] ?? 1);
    }
  }, [availableMonths, selectedMonth]);

  useEffect(() => {
    if (selectedDay > maxDayForSelection) {
      setSelectedDay(maxDayForSelection);
    }
  }, [maxDayForSelection, selectedDay]);

  const reloadList = useCallback(async () => {
    if (!sessionReady || !locationIdParam) {
      setItems([]);
      setNextCursor(null);
      return;
    }
    setListLoading(true);
    setListError("");
    try {
      const res = await searchOrders({
        locationId: locationIdParam,
        dateFrom: dateStr,
        dateTo: dateStr,
        limit: 50,
      });
      setItems(res.items ?? []);
      setNextCursor(res.nextCursor ?? null);
    } catch (e) {
      setListError(toUserMessage(e?.message) || "一覧の取得に失敗しました");
      setItems([]);
      setNextCursor(null);
    } finally {
      setListLoading(false);
    }
  }, [sessionReady, locationIdParam, dateStr]);

  useEffect(() => {
    reloadList();
  }, [reloadList]);

  const onLoadMore = useCallback(async () => {
    if (!nextCursor || !locationIdParam) return;
    setLoadingMore(true);
    try {
      const res = await searchOrders({
        locationId: locationIdParam,
        dateFrom: dateStr,
        dateTo: dateStr,
        limit: 50,
        cursor: nextCursor,
      });
      setItems((prev) => [...prev, ...(res.items ?? [])]);
      setNextCursor(res.nextCursor ?? null);
    } catch {
      // 無視（再読込で回復）
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, locationIdParam, dateStr]);

  return (
    <s-page heading={pageHeading}>
      <s-stack
        gap="none"
        blockSize="100%"
        inlineSize="100%"
        minBlockSize="0"
        style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}
      >
        <s-box
          padding="base"
          border="base"
          style={{
            position: "sticky",
            top: 0,
            background: "var(--s-color-bg)",
            zIndex: 10,
          }}
        >
          <s-stack gap="small">
            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%" }}>
              <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                {locLoadError ? (
                  <s-text tone="critical" size="small">{locLoadError}</s-text>
                ) : (
                  <s-text emphasis="bold" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {sessionReady ? locationName || "ロケーションを確認中…" : "セッション確認中…"}
                  </s-text>
                )}
              </s-box>
              {headerTrailing ? (
                <s-box style={{ flex: "0 0 auto" }}>{headerTrailing}</s-box>
              ) : null}
            </s-stack>

            <s-stack direction="inline" justifyContent="end" alignItems="center" gap="small" style={{ width: "100%", flexWrap: "wrap" }}>
              <s-box style={{ inlineSize: "4.75rem", flex: "0 0 4.75rem" }}>
                <s-button
                  kind="secondary"
                  style={{ width: "100%", maxInlineSize: "100%" }}
                  onClick={() => {
                    setMonthMenuOpen(false);
                    setDayMenuOpen(false);
                    setYearMenuOpen((v) => !v);
                  }}
                >
                  {selectedYear}年
                </s-button>
              </s-box>
              <s-box style={{ inlineSize: "4.75rem", flex: "0 0 4.75rem" }}>
                <s-button
                  kind="secondary"
                  style={{ width: "100%", maxInlineSize: "100%" }}
                  onClick={() => {
                    setYearMenuOpen(false);
                    setDayMenuOpen(false);
                    setMonthMenuOpen((v) => !v);
                  }}
                >
                  {selectedMonth}月
                </s-button>
              </s-box>
              <s-box style={{ inlineSize: "4.75rem", flex: "0 0 4.75rem" }}>
                <s-button
                  kind="secondary"
                  style={{ width: "100%", maxInlineSize: "100%" }}
                  onClick={() => {
                    setYearMenuOpen(false);
                    setMonthMenuOpen(false);
                    setDayMenuOpen((v) => !v);
                  }}
                >
                  {Math.min(selectedDay, maxDayForSelection)}日
                </s-button>
              </s-box>
            </s-stack>

            {yearMenuOpen ? (
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack direction="inline" gap="small" style={{ flexWrap: "wrap", width: "100%", alignItems: "center" }}>
                  {availableYears.map((y) => (
                    <s-button
                      key={`y-${y}`}
                      kind={y === selectedYear ? "primary" : "secondary"}
                      style={{ flex: "0 0 auto", width: "auto", maxInlineSize: "none" }}
                      onClick={() => {
                        setSelectedYear(y);
                        setYearMenuOpen(false);
                        setListError("");
                      }}
                    >
                      {y}年
                    </s-button>
                  ))}
                </s-stack>
              </s-box>
            ) : null}

            {monthMenuOpen ? (
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack direction="inline" gap="small" style={{ flexWrap: "wrap", width: "100%", alignItems: "center" }}>
                  {availableMonths.length === 0 ? (
                    <s-text tone="subdued" fontSize="small">選べる月がありません</s-text>
                  ) : (
                    availableMonths.map((m) => (
                      <s-button
                        key={`m-${m}`}
                        kind={m === selectedMonth ? "primary" : "secondary"}
                        style={{ flex: "0 0 auto", width: "auto", maxInlineSize: "none" }}
                        onClick={() => {
                          setSelectedMonth(m);
                          setMonthMenuOpen(false);
                          setListError("");
                        }}
                      >
                        {m}月
                      </s-button>
                    ))
                  )}
                </s-stack>
              </s-box>
            ) : null}

            {dayMenuOpen ? (
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack direction="inline" gap="small" style={{ flexWrap: "wrap", width: "100%", alignItems: "center" }}>
                  {availableDays.map((d) => (
                    <s-button
                      key={`d-${d}`}
                      kind={d === Math.min(selectedDay, maxDayForSelection) ? "primary" : "secondary"}
                      style={{ flex: "0 0 auto", width: "auto", maxInlineSize: "none" }}
                      onClick={() => {
                        setSelectedDay(d);
                        setDayMenuOpen(false);
                        setListError("");
                      }}
                    >
                      {d}日
                    </s-button>
                  ))}
                </s-stack>
              </s-box>
            ) : null}
          </s-stack>
        </s-box>

        <s-divider />

        <s-scroll-box
          blockSize="auto"
          maxBlockSize="100%"
          minBlockSize="0"
          style={{ flex: "1 1 0", minHeight: 0 }}
        >
          <s-box padding="base">
            <s-stack gap="base">
              {noticeError ? (
                <s-stack gap="small">
                  <s-text tone="critical" size="small">{noticeError}</s-text>
                  <s-button kind="plain" onClick={onDismissNotice}>閉じる</s-button>
                </s-stack>
              ) : null}
              {!sessionReady ? (
                <s-text tone="subdued" size="small">セッションを確認しています…</s-text>
              ) : !locationIdParam ? (
                <s-text tone="critical" size="small">POS のロケーションが取得できません。店舗を選び直してから開き直してください。</s-text>
              ) : listLoading ? (
                <s-text tone="subdued" size="small">読み込み中…</s-text>
              ) : listError ? (
                <s-stack gap="small">
                  <s-text tone="critical">{listError}</s-text>
                  <s-button kind="secondary" onClick={reloadList}>再読み込み</s-button>
                </s-stack>
              ) : items.length === 0 ? (
                <s-text tone="subdued" size="small">この日の取引はありません。</s-text>
              ) : (
                <s-stack gap="base">
                  {items.map((order) => {
                    const badges = formatPosBadgeLabels(order, badgeMode);
                    return (
                      <s-clickable
                        key={order.orderId}
                        onClick={() => onSelectOrderId(order.orderId)}
                      >
                        <s-box padding="small">
                          <s-stack gap="extraSmall">
                            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%" }}>
                              <s-text fontWeight="bold" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {order.orderName}
                              </s-text>
                              <s-text fontWeight="bold" size="small" style={{ whiteSpace: "nowrap" }}>
                                ¥{Number(order.totalPrice).toLocaleString()}
                              </s-text>
                            </s-stack>
                            <s-text tone="subdued" fontSize="small">
                              {order.customerName || "顧客なし"}
                            </s-text>
                            {badges.length > 0 ? (
                              <s-text tone="subdued" fontSize="small">
                                {badges.map((b) => `［${b}］`).join(" ")}
                              </s-text>
                            ) : null}
                          </s-stack>
                        </s-box>
                        <s-divider />
                      </s-clickable>
                    );
                  })}
                  {nextCursor ? (
                    <s-box paddingBlockStart="base">
                      <s-button kind="secondary" onClick={onLoadMore} loading={loadingMore}>
                        さらに読み込む
                      </s-button>
                    </s-box>
                  ) : null}
                </s-stack>
              )}
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-stack>
    </s-page>
  );
}
