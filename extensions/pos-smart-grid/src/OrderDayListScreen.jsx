/**
 * 取引を選ぶ一覧（POS 純正の「すべての注文」に見た目を合わせる）。
 * 上から: 検索欄 → 絞り込みのボタン（日付・種類）→「店名・18:14 に更新」→ 行（OrderListRow）。
 * 領収書・販売レシート・返金/商品券タイルで共有。
 *
 * 純正と違うところ（POS UI 拡張に同じ部品が無い）:
 * - 検索欄の右端のバーコード読み取りは無い
 * - 絞り込みは開かずに並べたまま出す（純正は下向きの印で開く）
 * - 日付は「今日」と年・月・日のボタンで選ぶ（純正は日付の絞り込みが無い）
 */
import { useState, useEffect, useCallback, useMemo } from "preact/hooks";
import { searchOrders } from "../../common/orderPickerApi.js";
import { getLocationsFromShopify } from "../../common/shopifyAdminGraphql.js";
import { useSessionLocation } from "../../common/sessionLocation.js";
import {
  LIST_SEGMENTS,
  matchesListSegment,
  formatListBadges,
  refundBadge,
  fmtYen,
} from "./orderDisplayUtils.js";
import {
  formatOrderDayLabel,
  formatOrderDateTimeLabel,
  formatOrderTitle,
} from "../../common/orderListLabels.js";
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

/**
 * 店の人に英語や「(HTTP 500)」のままのエラーを出さない（T 2026-11-23）。
 * 日本語の文はそのまま、英語まじりの文は決まった日本語にする。
 */
export function storeFacingNotice(message) {
  const m = String(message ?? "").trim();
  if (!m) return "";
  if (/[A-Za-z]{4,}|HTTP\s*\d{3}/.test(m)) {
    return "注文を読み込めませんでした。少し待ってから、もう一度注文を選んでください。";
  }
  return m;
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
    if (b.receiptIssued)
      out.push({ key: "receipt", label: "領収書発行済", tone: "success" });
    if (b.refundedShopify)
      out.push(refundBadge(item));
    if (b.voucherLikeGateway)
      out.push({ key: "voucher", label: "商品券決済", tone: "neutral" });
    return out;
  }
  return formatListBadges(item);
}

/**
 * @param {object} props
 * @param {string} props.pageHeading - s-page heading
 * @param {"receipt" | "specialRefund"} props.badgeMode
 * @param {(orderId: string) => void} props.onSelectOrderId
 * @param {import("preact").ComponentChildren} [props.footerTrailing] - 画面の下の右に固定する操作（例: 領収書の履歴）
 * @param {() => void} [props.onBack] - あると下の固定の左に「戻る」を出す（戻る系は左の「戻る」に統一。T 2026-11-23）
 * @param {string} [props.noticeError] - 一覧上部に出す一時メッセージ（取引詳細からの起動失敗など）
 * @param {() => void} [props.onDismissNotice]
 * @param {"all" | "refunded" | "voucher_change"} [props.initialSegment] - 開いたときの絞り込み（タイルごとに変える）
 * @param {{ value: string, label: string, noun: string }[]} [props.segments] - 出す絞り込み（既定は全部）
 * @param {string} [props.listNote] - 一覧の上に出す案内（1 行）
 * @param {{ label: string, onClick: () => void } | null} [props.listAction] - 画面の下の固定の右に出すボタン（1 つ。「会計前に登録」など。T 2026-11-24）
 * @param {(params: object) => Promise<{ items: object[], nextCursor?: string|null, todayLocalDate?: string, fetchedAtTime?: string }>} [props.fetchList]
 *   一覧の読み込み（既定は注文の検索）。領収書の発行履歴は発行の記録を読む
 * @param {(item: object, todayKey: string) => { key: string, title: string, amountLabel: string, dateTimeLabel: string, badges: object[], selectId?: string }} [props.toRow]
 *   1 件を行の形にする（既定は注文）
 * @param {string} [props.itemNoun] - 「今日の取引はありません」の「取引」
 * @param {string} [props.searchPlaceholder]
 * @param {string} [props.searchHint] - 検索で 0 件のときの案内
 */
export function OrderDayListScreen({
  pageHeading,
  badgeMode,
  onSelectOrderId,
  footerTrailing = null,
  onBack = null,
  noticeError = "",
  onDismissNotice = () => {},
  initialSegment = "all",
  segments = LIST_SEGMENTS,
  listNote = "",
  listAction = null,
  fetchList = searchOrders,
  toRow = null,
  itemNoun = "取引",
  searchPlaceholder = "注文番号・顧客名で検索",
  searchHint = "注文番号は数字だけでも探せます。顧客名は 2 文字以上入れてください。",
}) {
  const t0 = useMemo(() => todayYmd(), []);
  const {
    locationGid,
    locationIdParam,
    isReady: sessionReady,
  } = useSessionLocation();

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

  const dateStr = ymdToStr(
    selectedYear,
    selectedMonth,
    Math.min(selectedDay, maxDayForSelection),
  );

  useEffect(() => {
    if (!sessionReady) return;
    if (!locationGid) {
      setLocationName("");
      return;
    }
    getLocationsFromShopify(80)
      .then((res) => {
        const locs = res.locations ?? [];
        const hit = locs.find(
          (l) =>
            l.locationId === locationGid ||
            String(l.locationId).endsWith(locationIdParam ?? ""),
        );
        setLocationName(hit?.locationName ?? "この店舗");
        setLocLoadError("");
      })
      .catch(() => {
        setLocationName(
          locationIdParam ? `店舗 #${locationIdParam}` : "この店舗",
        );
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
      const res = await fetchList(buildSearchParams());
      setItems(res.items ?? []);
      setNextCursor(res.nextCursor ?? null);
      setTodayLocalDate(res.todayLocalDate || "");
      setFetchedAtTime(res.fetchedAtTime || "");
    } catch (e) {
      // 店の人に英語や番号のエラーを出さない（T 2026-11-23）
      setListError(
        `${itemNoun === "取引" ? "注文" : "履歴"}を読み込めませんでした。少し待ってから「再読み込み」を押してください。`,
      );
      setItems([]);
      setNextCursor(null);
    } finally {
      setListLoading(false);
    }
  }, [sessionReady, locationIdParam, buildSearchParams, fetchList]);

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
      const res = await fetchList(buildSearchParams(nextCursor));
      setItems((prev) => [...prev, ...(res.items ?? [])]);
      setNextCursor(res.nextCursor ?? null);
    } catch {
      // 無視（再読込で回復）
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, locationIdParam, buildSearchParams, fetchList]);

  const todayKey = todayLocalDate || ymdToStr(t0.y, t0.m, t0.day);
  const dayChipLabel = formatOrderDayLabel(dateStr, todayKey) || dateStr;
  const visibleItems = items.filter((order) =>
    matchesListSegment(order, effectiveSegment),
  );
  const storeLabel = sessionReady ? locationName || "店舗を確認中…" : "確認中…";

  const isTodaySelected = dateStr === ymdToStr(t0.y, t0.m, t0.day);

  const selectYmd = (ymd) => {
    setSelectedYear(ymd.y);
    setSelectedMonth(ymd.m);
    setSelectedDay(ymd.day);
    setYearMenuOpen(false);
    setMonthMenuOpen(false);
    setDayMenuOpen(false);
    setListError("");
  };

  const closeDateMenus = () => {
    setYearMenuOpen(false);
    setMonthMenuOpen(false);
    setDayMenuOpen(false);
  };

  // 下の固定の右: 領収書の「履歴」など。無ければ「会計前に登録」などの一覧のボタン（T 2026-11-24: 一覧の上ではなく右下）
  const trailing =
    footerTrailing ??
    (listAction ? (
      <s-button variant="secondary" onClick={listAction.onClick}>
        {listAction.label}
      </s-button>
    ) : null);

  return (
    <s-page heading={pageHeading}>
      <s-stack
        gap="none"
        blockSize="100%"
        inlineSize="100%"
        minBlockSize="0"
        style={{
          display: "flex",
          flexDirection: "column",
          flex: "1 1 auto",
          minHeight: 0,
        }}
      >
        {/* 上の固定: 検索欄〜「店名・時刻 に更新」まではスクロールしても動かない（直す前と同じ作り） */}
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
              placeholder={searchPlaceholder}
              value={searchDraft}
              onInput={(e) => setSearchDraft(e?.currentTarget?.value ?? "")}
            />
            {searchDraft.trim().length === 1 ? (
              <s-text type="small" color="subdued">
                あと1文字入力すると検索します
              </s-text>
            ) : null}

            {/* 絞り込みのボタン。選ぶものが少ないので開かずに並べたまま出す（T 2026-11-23） */}
            {/* 左に年・月・日、右端に「今日」（一覧の行の金額と同じ space-between。T 2026-11-23） */}
            <s-stack
              direction="inline"
              justifyContent="space-between"
              alignItems="center"
              gap="small-300"
            >
              {isSearchMode ? (
                <s-button
                  variant="secondary"
                  onClick={clearSearch}
                  disabled={listLoading}
                >
                  検索をクリア
                </s-button>
              ) : (
                <>
                  {/* 今日の分を扱うことが多いので年・月・日のボタン。日付を変えたとき用に「今日」へ戻すボタン（T 2026-11-23） */}
                  <s-stack
                    direction="inline"
                    gap="small-300"
                    alignItems="center"
                  >
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
                  <s-button
                    variant={isTodaySelected ? "primary" : "secondary"}
                    onClick={() => selectYmd(t0)}
                  >
                    今日
                  </s-button>
                </>
              )}
            </s-stack>

            {/* 年・月・日の選択肢は日付のボタンのすぐ下に出す（種類の段の下に出ていた。T 2026-11-23） */}
            {!isSearchMode && (yearMenuOpen || monthMenuOpen || dayMenuOpen) ? (
              <s-stack gap="small-300">
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
                    <s-text type="small" color="subdued">
                      選べる月がありません
                    </s-text>
                  ) : (
                    <s-stack direction="inline" gap="small-300">
                      {availableMonths.map((m) => (
                        <s-button
                          key={`m-${m}`}
                          variant={
                            m === selectedMonth ? "primary" : "secondary"
                          }
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
                        variant={
                          d === Math.min(selectedDay, maxDayForSelection)
                            ? "primary"
                            : "secondary"
                        }
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
                ) : null}
              </s-stack>
            ) : null}

            {badgeMode === "specialRefund" ? (
              /* 幅いっぱいに均等（POS Stock の「未入庫／入庫済み」と同じ。T 2026-11-23）。
                 s-button に幅の指定は無いので、幅を割った s-box に入れる */
              <s-stack direction="inline" gap="none" alignItems="center" inlineSize="100%">
                {segments.map((seg, i) => (
                  <s-box
                    key={seg.value}
                    inlineSize={`${(100 / segments.length).toFixed(2)}%`}
                    paddingInlineStart={i === 0 ? "none" : "small-500"}
                    paddingInlineEnd={i === segments.length - 1 ? "none" : "small-500"}
                  >
                    <s-button
                      variant={
                        effectiveSegment === seg.value ? "primary" : "secondary"
                      }
                      onClick={() => {
                        setListSegment(seg.value);
                        if (isSearchMode) {
                          setSearchDraft("");
                          setSearchQuery("");
                        }
                      }}
                    >
                      {seg.label}
                    </s-button>
                  </s-box>
                ))}
              </s-stack>
            ) : null}

            {/* 純正の「たった今に更新」の位置。店名と取得した時刻（店のタイムゾーン） */}
            {locLoadError ? (
              <s-text type="small" tone="critical">
                {locLoadError}
              </s-text>
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

        {/* 境目の線（POS の s-box に枠線の指定は無いので s-divider で引く） */}
        <s-divider />

        <s-scroll-box
          blockSize="auto"
          maxBlockSize="100%"
          minBlockSize="0"
          style={{ flex: "1 1 0", minHeight: 0 }}
        >
          {/* 固定の線と一覧の間に余白（T 2026-11-23） */}
          <s-box padding="base">
            <s-stack gap="base">
              {listNote ? <s-text color="subdued">{listNote}</s-text> : null}
              {noticeError ? (
                <s-stack gap="small-300">
                  <s-banner tone="critical" heading={storeFacingNotice(noticeError)} />
                  <s-button variant="secondary" onClick={onDismissNotice}>
                    閉じる
                  </s-button>
                </s-stack>
              ) : null}
              {!sessionReady ? (
                <s-text type="small" color="subdued">
                  確認しています…
                </s-text>
              ) : !locationIdParam ? (
                <s-text type="small" tone="critical">
                  POS
                  の店舗が分かりません。店舗を選び直してから開き直してください。
                </s-text>
              ) : listLoading ? (
                <s-text type="small" color="subdued">
                  読み込み中…
                </s-text>
              ) : listError ? (
                <s-stack gap="small">
                  <s-text tone="critical">{listError}</s-text>
                  <s-button variant="secondary" onClick={reloadList}>
                    再読み込み
                  </s-button>
                </s-stack>
              ) : items.length === 0 ? (
                <s-stack gap="small-300">
                  <s-text>
                    {isSearchMode
                      ? `該当する${itemNoun}は見つかりませんでした。`
                      : `${dayChipLabel}の${itemNoun}はありません。`}
                  </s-text>
                  <s-text type="small" color="subdued">
                    {isSearchMode
                      ? searchHint
                      : "ほかの日は年・月・日のボタンから選べます。上の欄から探すこともできます。"}
                  </s-text>
                  {!isSearchMode ? (
                    <s-button variant="secondary" onClick={reloadList}>
                      再読み込み
                    </s-button>
                  ) : null}
                </s-stack>
              ) : (
                <s-stack gap="small">
                  {visibleItems.length === 0 ? (
                    <s-stack gap="small-300">
                      <s-text>
                        {`${dayChipLabel}の取引は ${items.length} 件ありますが、${
                          segments.find(
                            (x) => x.value === effectiveSegment,
                          )?.noun ?? ""
                        }の取引はありません。`}
                      </s-text>
                      <s-button
                        variant="secondary"
                        onClick={() => setListSegment("all")}
                      >
                        すべて表示する
                      </s-button>
                    </s-stack>
                  ) : null}
                  {visibleItems.map((item) => {
                    const row = toRow
                      ? toRow(item, todayKey)
                      : {
                          key: item.orderId,
                          title: formatOrderTitle(item),
                          amountLabel: fmtYen(item.totalPrice),
                          dateTimeLabel: formatOrderDateTimeLabel(item, todayKey),
                          badges: formatPosBadges(item, badgeMode),
                          selectId: item.orderId,
                        };
                    return (
                      <OrderListRow
                        key={row.key}
                        title={row.title}
                        amountLabel={row.amountLabel}
                        dateTimeLabel={row.dateTimeLabel}
                        badges={row.badges}
                        onClick={
                          onSelectOrderId && row.selectId
                            ? () => onSelectOrderId(row.selectId)
                            : undefined
                        }
                      />
                    );
                  })}
                  {nextCursor ? (
                    <s-box paddingBlockStart="base">
                      <s-button
                        variant="secondary"
                        onClick={onLoadMore}
                        loading={loadingMore}
                      >
                        さらに読み込む
                      </s-button>
                    </s-box>
                  ) : null}
                </s-stack>
              )}
            </s-stack>
          </s-box>
        </s-scroll-box>

        {trailing || onBack ? <s-divider /> : null}
        {trailing || onBack ? (
          /* 下の固定: 左に「戻る」、右に領収書の「履歴」など。FixedFooterNavBar と同じ作り */
          <s-box
            padding="base"
            style={{
              position: "sticky",
              bottom: 0,
              background: "var(--s-color-bg)",
              zIndex: 10,
            }}
          >
            <s-stack
              direction="inline"
              justifyContent="space-between"
              alignItems="center"
              gap="small"
            >
              {onBack ? (
                <s-button variant="secondary" onClick={onBack}>
                  戻る
                </s-button>
              ) : (
                <s-box />
              )}
              {trailing ?? <s-box />}
            </s-stack>
          </s-box>
        ) : null}
      </s-stack>
    </s-page>
  );
}
