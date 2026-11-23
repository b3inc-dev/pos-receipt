/**
 * 取引を選ぶ一覧（POS 純正の「すべての注文」に見た目を合わせる）。
 * 上から: 検索欄 → 絞り込みのボタン（日付・種類）→「店名・18:14 に更新」→ 行（OrderListRow）。
 * 領収書・販売レシート・返金/商品券タイルで共有。
 *
 * 純正と違うところ（POS UI 拡張に同じ部品が無い）:
 * - 検索欄の右端のバーコード読み取りは無い
 * - 絞り込みのボタンに下向きの印（アイコン）を入れられないので「▾」の字で出す
 * - 日付は年・月・日のボタンで選ぶ（純正は日付の絞り込みが無い）
 */
import { useState, useEffect, useCallback, useMemo } from "preact/hooks";
import { searchOrders } from "../../common/orderPickerApi.js";
import { getLocationsFromShopify } from "../../common/shopifyAdminGraphql.js";
import { useSessionLocation } from "../../common/sessionLocation.js";
import { toUserMessage } from "../../common/errorMessage.js";
import {
  LIST_SEGMENTS,
  matchesListSegment,
  formatListBadges,
  fmtYen,
} from "./orderDisplayUtils.js";
import { formatOrderDayLabel, formatOrderDateTimeLabel, formatOrderTitle } from "../../common/orderListLabels.js";
import { OrderListRow } from "./OrderListRow.jsx";

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
 * 一覧の行に付けるバッジ（色付き）
 * @param {object} item - searchOrders の1件
 * @param {"receipt" | "specialRefund"} badgeMode
 * @returns {{ key: string, label: string, tone: string }[]}
 */
export function formatPosBadges(item, badgeMode) {
  if (badgeMode === "receipt") {
    const b = item?.posBadges ?? {};
    const out = [];
    if (b.receiptIssued) out.push({ key: "receipt", label: "領収書発行済", tone: "success" });
    if (b.refundedShopify) out.push({ key: "refund", label: "返金済", tone: "warning" });
    if (b.voucherLikeGateway) out.push({ key: "voucher", label: "商品券決済", tone: "neutral" });
    return out;
  }
  return formatListBadges(item);
}

/**
 * @param {object} props
 * @param {string} props.pageHeading - s-page heading
 * @param {"receipt" | "specialRefund"} props.badgeMode
 * @param {(orderId: string) => void} props.onSelectOrderId
 * @param {import("preact").ComponentChildren} [props.headerTrailing] - ヘッダー右寄せの横に並べる操作（例: 履歴）
 * @param {string} [props.noticeError] - 一覧上部に出す一時メッセージ（取引詳細からの起動失敗など）
 * @param {() => void} [props.onDismissNotice]
 * @param {"all" | "refunded" | "voucher_change"} [props.initialSegment] - 開いたときの絞り込み（タイルごとに変える）
 */
export function OrderDayListScreen({
  pageHeading,
  badgeMode,
  onSelectOrderId,
  headerTrailing = null,
  noticeError = "",
  onDismissNotice = () => {},
  initialSegment = "all",
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
  const [listSegment, setListSegment] = useState(initialSegment);
  const [segmentMenuOpen, setSegmentMenuOpen] = useState(false);
  const [dateMenuOpen, setDateMenuOpen] = useState(false);
  // 店のタイムゾーンの「今日」と取得した時刻（サーバーが返す。無いときは端末の日付）
  const [todayLocalDate, setTodayLocalDate] = useState("");
  const [fetchedAtTime, setFetchedAtTime] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const isSearchMode = searchQuery.trim().length > 0;
  // 注文番号で探すときは絞り込まない（返金前の注文も出す。特殊返金でアプリが Shopify の返金もする店のため）
  const effectiveSegment = isSearchMode ? "all" : listSegment;

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

  const buildSearchParams = useCallback(
    (cursor) => {
      const base = { locationId: locationIdParam, limit: 50, cursor };
      if (isSearchMode) {
        return { ...base, q: searchQuery.trim() };
      }
      return { ...base, dateFrom: dateStr, dateTo: dateStr };
    },
    [locationIdParam, isSearchMode, searchQuery, dateStr],
  );

  const reloadList = useCallback(async () => {
    if (!sessionReady || !locationIdParam) {
      setItems([]);
      setNextCursor(null);
      return;
    }
    setListLoading(true);
    setListError("");
    try {
      const res = await searchOrders(buildSearchParams());
      setItems(res.items ?? []);
      setNextCursor(res.nextCursor ?? null);
      setTodayLocalDate(res.todayLocalDate || "");
      setFetchedAtTime(res.fetchedAtTime || "");
    } catch (e) {
      setListError(toUserMessage(e?.message) || "一覧の取得に失敗しました");
      setItems([]);
      setNextCursor(null);
    } finally {
      setListLoading(false);
    }
  }, [sessionReady, locationIdParam, buildSearchParams]);

  const clearSearch = useCallback(() => {
    setSearchDraft("");
    setSearchQuery("");
    setListError("");
  }, []);

  useEffect(() => {
    reloadList();
  }, [reloadList]);

  // 入力のたびに一覧を更新（POS Stock の商品検索と同様。短い語は誤ヒットを避けるため最小文字数あり）
  useEffect(() => {
    const trimmed = searchDraft.trim();
    if (trimmed.length > 0 && trimmed.length < 2) return;
    const timer = setTimeout(() => {
      setSearchQuery(trimmed);
      setListError("");
    }, 400);
    return () => clearTimeout(timer);
  }, [searchDraft]);

  const onLoadMore = useCallback(async () => {
    if (!nextCursor || !locationIdParam) return;
    setLoadingMore(true);
    try {
      const res = await searchOrders(buildSearchParams(nextCursor));
      setItems((prev) => [...prev, ...(res.items ?? [])]);
      setNextCursor(res.nextCursor ?? null);
    } catch {
      // 無視（再読込で回復）
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, locationIdParam, buildSearchParams]);

  const todayKey = todayLocalDate || ymdToStr(t0.y, t0.m, t0.day);
  const dayChipLabel = formatOrderDayLabel(dateStr, todayKey) || dateStr;
  const segmentLabel = LIST_SEGMENTS.find((x) => x.value === effectiveSegment)?.label ?? "すべて";
  const visibleItems = items.filter((order) => matchesListSegment(order, effectiveSegment));
  const storeLabel = sessionReady ? locationName || "店舗を確認中…" : "確認中…";

  const closeDateMenus = () => {
    setYearMenuOpen(false);
    setMonthMenuOpen(false);
    setDayMenuOpen(false);
  };

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
          style={{
            position: "sticky",
            top: 0,
            background: "var(--s-color-bg)",
            zIndex: 10,
          }}
        >
          <s-stack gap="small">
            <s-search-field
              placeholder="注文番号・顧客名で検索"
              value={searchDraft}
              onInput={(e) => setSearchDraft(e?.currentTarget?.value ?? "")}
            />
            {searchDraft.trim().length === 1 ? (
              <s-text type="small" color="subdued">あと1文字入力すると検索します</s-text>
            ) : null}

            {/* 絞り込みのボタン（純正の「POS ▾」「BBB渋谷店 ▾」の並び） */}
            <s-stack direction="inline" gap="small-300" alignItems="center">
              {isSearchMode ? (
                <s-button variant="secondary" onClick={clearSearch} disabled={listLoading}>
                  検索をクリア
                </s-button>
              ) : (
                <s-button
                  variant={dateMenuOpen ? "primary" : "secondary"}
                  onClick={() => {
                    setSegmentMenuOpen(false);
                    closeDateMenus();
                    setDateMenuOpen((v) => !v);
                  }}
                >
                  {`${dayChipLabel} ▾`}
                </s-button>
              )}
              {badgeMode === "specialRefund" ? (
                <s-button
                  variant={segmentMenuOpen ? "primary" : "secondary"}
                  onClick={() => {
                    setDateMenuOpen(false);
                    closeDateMenus();
                    setSegmentMenuOpen((v) => !v);
                  }}
                >
                  {`${segmentLabel} ▾`}
                </s-button>
              ) : null}
              {headerTrailing}
            </s-stack>

            {dateMenuOpen && !isSearchMode ? (
              <s-stack gap="small-300">
                <s-stack direction="inline" gap="small-300">
                  <s-button
                    variant="secondary"
                    onClick={() => {
                      setSelectedYear(t0.y);
                      setSelectedMonth(t0.m);
                      setSelectedDay(t0.day);
                      closeDateMenus();
                      setDateMenuOpen(false);
                      setListError("");
                    }}
                  >
                    今日
                  </s-button>
                  <s-button
                    variant={yearMenuOpen ? "primary" : "secondary"}
                    onClick={() => {
                      setMonthMenuOpen(false);
                      setDayMenuOpen(false);
                      setYearMenuOpen((v) => !v);
                    }}
                  >
                    {selectedYear}年
                  </s-button>
                  <s-button
                    variant={monthMenuOpen ? "primary" : "secondary"}
                    onClick={() => {
                      setYearMenuOpen(false);
                      setDayMenuOpen(false);
                      setMonthMenuOpen((v) => !v);
                    }}
                  >
                    {selectedMonth}月
                  </s-button>
                  <s-button
                    variant={dayMenuOpen ? "primary" : "secondary"}
                    onClick={() => {
                      setYearMenuOpen(false);
                      setMonthMenuOpen(false);
                      setDayMenuOpen((v) => !v);
                    }}
                  >
                    {Math.min(selectedDay, maxDayForSelection)}日
                  </s-button>
                </s-stack>

                {yearMenuOpen ? (
                  <s-stack direction="inline" gap="small-300">
                    {availableYears.map((y) => (
                      <s-button
                        key={`y-${y}`}
                        variant={y === selectedYear ? "primary" : "secondary"}
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
                ) : null}

                {monthMenuOpen ? (
                  availableMonths.length === 0 ? (
                    <s-text type="small" color="subdued">選べる月がありません</s-text>
                  ) : (
                    <s-stack direction="inline" gap="small-300">
                      {availableMonths.map((m) => (
                        <s-button
                          key={`m-${m}`}
                          variant={m === selectedMonth ? "primary" : "secondary"}
                          onClick={() => {
                            setSelectedMonth(m);
                            setMonthMenuOpen(false);
                            setListError("");
                          }}
                        >
                          {m}月
                        </s-button>
                      ))}
                    </s-stack>
                  )
                ) : null}

                {dayMenuOpen ? (
                  <s-stack direction="inline" gap="small-300">
                    {availableDays.map((d) => (
                      <s-button
                        key={`d-${d}`}
                        variant={d === Math.min(selectedDay, maxDayForSelection) ? "primary" : "secondary"}
                        onClick={() => {
                          setSelectedDay(d);
                          setDayMenuOpen(false);
                          setDateMenuOpen(false);
                          setListError("");
                        }}
                      >
                        {d}日
                      </s-button>
                    ))}
                  </s-stack>
                ) : null}
              </s-stack>
            ) : null}

            {segmentMenuOpen && badgeMode === "specialRefund" ? (
              <s-stack direction="inline" gap="small-300">
                {LIST_SEGMENTS.map((seg) => (
                  <s-button
                    key={seg.value}
                    variant={effectiveSegment === seg.value ? "primary" : "secondary"}
                    onClick={() => {
                      setListSegment(seg.value);
                      setSegmentMenuOpen(false);
                      if (isSearchMode) {
                        setSearchDraft("");
                        setSearchQuery("");
                      }
                    }}
                  >
                    {seg.label}
                  </s-button>
                ))}
              </s-stack>
            ) : null}

            {/* 純正の「たった今に更新」の位置。店名と取得した時刻（店のタイムゾーン） */}
            {locLoadError ? (
              <s-text type="small" tone="critical">{locLoadError}</s-text>
            ) : (
              <s-text type="small" color="subdued">
                {isSearchMode
                  ? `${storeLabel}の過去の注文から「${searchQuery}」を探しています`
                  : fetchedAtTime && !listLoading
                    ? `${storeLabel}・${fetchedAtTime} に更新`
                    : storeLabel}
              </s-text>
            )}
          </s-stack>
        </s-box>

        <s-scroll-box
          blockSize="auto"
          maxBlockSize="100%"
          minBlockSize="0"
          style={{ flex: "1 1 0", minHeight: 0 }}
        >
          <s-box paddingInline="base" paddingBlockEnd="base">
            <s-stack gap="base">
              {noticeError ? (
                <s-stack gap="small-300">
                  <s-banner tone="critical" heading={noticeError} />
                  <s-button variant="secondary" onClick={onDismissNotice}>閉じる</s-button>
                </s-stack>
              ) : null}
              {!sessionReady ? (
                <s-text type="small" color="subdued">確認しています…</s-text>
              ) : !locationIdParam ? (
                <s-text type="small" tone="critical">POS の店舗が分かりません。店舗を選び直してから開き直してください。</s-text>
              ) : listLoading ? (
                <s-text type="small" color="subdued">読み込み中…</s-text>
              ) : listError ? (
                <s-stack gap="small">
                  <s-text tone="critical">{listError}</s-text>
                  <s-button variant="secondary" onClick={reloadList}>再読み込み</s-button>
                </s-stack>
              ) : items.length === 0 ? (
                <s-text type="small" color="subdued">
                  {isSearchMode ? "該当する取引は見つかりませんでした。" : "この日の取引はありません。"}
                </s-text>
              ) : (
                <s-stack gap="small">
                  {visibleItems.length === 0 ? (
                    <s-text type="small" color="subdued">この条件の取引はありません。</s-text>
                  ) : null}
                  {visibleItems.map((order) => (
                    <OrderListRow
                      key={order.orderId}
                      title={formatOrderTitle(order)}
                      amountLabel={fmtYen(order.totalPrice)}
                      dateTimeLabel={formatOrderDateTimeLabel(order, todayKey)}
                      badges={formatPosBadges(order, badgeMode)}
                      onClick={() => onSelectOrderId(order.orderId)}
                    />
                  ))}
                  {nextCursor ? (
                    <s-box paddingBlockStart="base">
                      <s-button variant="secondary" onClick={onLoadMore} loading={loadingMore}>
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
