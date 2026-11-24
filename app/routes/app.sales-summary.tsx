/** 売上サマリーはメニューを先に表示し、集計結果だけ別リクエストで取得する。 */
import type { LoaderFunctionArgs } from "react-router";
import { useFetcher, useLocation, useSearchParams, useRouteError } from "react-router";
import { useEffect, useMemo } from "react";
import { Page, Layout, Card, Text, Banner, BlockStack, InlineStack, Select, Box, DataTable, Button, InlineGrid, SkeletonBodyText, SkeletonDisplayText } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import type { loader as loadSummaryData } from "./app.sales-summary-data";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, REPORTS_TABS } from "../components/TabGroupBar";
import { sumOptionalBudgetColumn } from "../utils/salesSummaryTotals";
export async function loader({request}: LoaderFunctionArgs) { await authenticate.admin(request); return {}; }
function fmtYen(n: number | null) {
  if (n === null) return "-";
  return `¥${Math.round(n).toLocaleString("ja-JP")}`;
}
function fmtPct(n: number | null) {
  if (n === null) return "-";
  return `${(n * 100).toFixed(1)}%`;
}
function fmtDecimal(n: number | null, decimals: number) {
  if (n === null || n === undefined) return "-";
  return Number(n).toLocaleString("ja-JP", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** 日次合計セルを生成する（visitorsを持たない行は visitors=null として扱われる） */
function buildDailyTotalRowCells(rows: Array<Record<string, unknown>>, label = "POS合計"): string[] | null {
  if (rows.length === 0) return null;
  let actual = 0, orders = 0, items = 0, visitorsAcc = 0;
  let haveVisitors = false;
  for (const r of rows) {
    actual += Number(r.actual ?? 0);
    orders += Number(r.orders ?? 0);
    items += Number(r.items ?? 0);
    if (r.visitors != null) { haveVisitors = true; visitorsAcc += Number(r.visitors); }
  }
  const budget = sumOptionalBudgetColumn(rows, "budget");
  const budgetRatio = budget != null && budget > 0 ? actual / budget : null;
  const visitors = haveVisitors ? visitorsAcc : null;
  const conv = visitors != null && visitors > 0 ? orders / visitors : null;
  const atv = orders > 0 ? actual / orders : null;
  const setRate = orders > 0 ? items / orders : null;
  const unit = items > 0 ? actual / items : null;
  return [
    label,
    fmtYen(actual),
    budget != null ? fmtYen(budget) : "-",
    fmtPct(budgetRatio),
    `${orders.toLocaleString("ja-JP")}件`,
    visitors != null ? `${visitors.toLocaleString("ja-JP")}人` : "-",
    fmtPct(conv),
    fmtYen(atv),
    fmtDecimal(setRate, 2),
    `${items.toLocaleString("ja-JP")}点`,
    fmtYen(unit),
  ];
}

/** 月次合計セルを生成する */
function buildPeriodTotalRowCells(rows: Array<Record<string, unknown>>, label = "POS合計"): string[] | null {
  if (rows.length === 0) return null;
  let actualTotal = 0, orders = 0, items = 0;
  let progressBudgetToday = 0, progressBudgetPrev = 0;
  let visitorsAcc = 0, haveVisitors = false;
  for (const r of rows) {
    actualTotal += Number(r.actualTotal ?? 0);
    orders += Number(r.orders ?? 0);
    items += Number(r.items ?? 0);
    progressBudgetToday += Number(r.progressBudgetToday ?? 0);
    progressBudgetPrev += Number(r.progressBudgetPrev ?? 0);
    if (r.visitors != null) { haveVisitors = true; visitorsAcc += Number(r.visitors); }
  }
  const budgetTotal = sumOptionalBudgetColumn(rows, "budgetTotal");
  const achievementRate = budgetTotal != null && budgetTotal > 0 ? actualTotal / budgetTotal : null;
  const progressRateToday = progressBudgetToday > 0 ? actualTotal / progressBudgetToday : null;
  const progressRatePrev = progressBudgetPrev > 0 ? actualTotal / progressBudgetPrev : null;
  const visitors = haveVisitors ? visitorsAcc : null;
  const conv = visitors != null && visitors > 0 ? orders / visitors : null;
  const atv = orders > 0 ? actualTotal / orders : null;
  const setRate = orders > 0 ? items / orders : null;
  const unit = items > 0 ? actualTotal / items : null;
  return [
    label,
    fmtYen(actualTotal),
    budgetTotal != null ? fmtYen(budgetTotal) : "-",
    fmtPct(achievementRate),
    progressBudgetToday > 0 ? fmtYen(progressBudgetToday) : "-",
    fmtPct(progressRateToday),
    progressBudgetPrev > 0 ? fmtYen(progressBudgetPrev) : "-",
    fmtPct(progressRatePrev),
    `${orders.toLocaleString("ja-JP")}件`,
    visitors != null ? `${visitors.toLocaleString("ja-JP")}人` : "-",
    fmtPct(conv),
    fmtYen(atv),
    fmtDecimal(setRate, 2),
    `${items.toLocaleString("ja-JP")}点`,
    fmtYen(unit),
  ];
}

export default function SalesSummaryAdminPage() {
  const fetcher = useFetcher<typeof loadSummaryData>();
  const location = useLocation();
  const target = "/app/sales-summary-data" + location.search;
  useEffect(() => { fetcher.load(target); }, [target]);
  if (!fetcher.data || fetcher.state !== "idle" || fetcher.data.requestKey !== location.search) return <SalesSummaryPending />;
  return <SalesSummaryContent data={{...fetcher.data, rows: fetcher.data.rows.map(row=>({...row})), channelRows: fetcher.data.channelRows.map(row=>({...row}))}} />;
}

export function SalesSummaryPending() {
  const [params] = useSearchParams();
  const period = params.get("view") === "period";
  return <PolarisPageWrapper><Page title="売上サマリー">
    <TabGroupBar tabs={REPORTS_TABS} />
    <Layout>
      <Layout.Section><SalesSummaryFilters /></Layout.Section>
      <Layout.Section><SummaryCards period={period} /></Layout.Section>
      <Layout.Section><Card><BlockStack gap="400">
        <Text as="h2" variant="headingMd">{period ? "月次" : "日次"}の店舗・チャネル別実績</Text>
        <Text as="p"><span role="status">集計しています。数字は集計後に表示されます。</span></Text>
        <div aria-hidden="true"><SkeletonBodyText lines={6}/></div>
      </BlockStack></Card></Layout.Section>
    </Layout>
  </Page></PolarisPageWrapper>;
}

export function SummaryCards({period, values}: {period: boolean; values?: string[]}) {
  const labels = [period ? "月実績" : "売上実績", period ? "月予算" : "予算", "件数", "点数"];
  return <InlineGrid columns={{xs: 2, md: 4}} gap="400">{labels.map((label,index)=><Card key={label}><BlockStack gap="300">
    <Text as="h2" variant="headingSm">{label}</Text>
    {values ? <Text as="p" variant="headingLg">{values[index]}</Text> : <div aria-label={`${label}を集計中`}><SkeletonDisplayText size="small" /></div>}
  </BlockStack></Card>)}</InlineGrid>;
}

export function ErrorBoundary() {
  const error = useRouteError();
  return <PolarisPageWrapper><Page title="売上サマリー">
    <TabGroupBar tabs={REPORTS_TABS} />
    <Banner tone="critical">集計結果を読み込めませんでした。上のメニューから別の画面へ移動できます。{error instanceof Error ? error.message : "時間をおいてもう一度お試しください。"}</Banner>
  </Page></PolarisPageWrapper>;
}

type SummaryData = Omit<Exclude<Awaited<ReturnType<typeof loadSummaryData>>, Response>, "rows" | "channelRows"> & { rows: Array<Record<string, unknown>>; channelRows: Array<Record<string, unknown>> };

function SalesSummaryContent({data}: {data: SummaryData}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const recomputeDebug = (data as any).recomputeDebug as
    | null
    | { locations?: Array<any>; channels?: Array<any> };
  const recomputeDebugLocations = recomputeDebug?.locations ?? [];
  const recomputeDebugChannels = recomputeDebug?.channels ?? [];

  const tableRows = useMemo(() => {
    if (!data.hasAccess) return [];
    const locationBody =
      data.view === "daily"
        ? data.rows.map((r) => [
            String(r.locationName ?? ""),
            fmtYen((r.actual as number) ?? 0),
            fmtYen((r.budget as number | null) ?? null),
            fmtPct((r.budgetRatio as number | null) ?? null),
            `${Number(r.orders ?? 0).toLocaleString("ja-JP")}件`,
            r.visitors != null ? `${Number(r.visitors).toLocaleString("ja-JP")}人` : "-",
            fmtPct((r.conv as number | null) ?? null),
            fmtYen((r.atv as number | null) ?? null),
            fmtDecimal((r.setRate as number | null) ?? null, 2),
            `${Number(r.items ?? 0).toLocaleString("ja-JP")}点`,
            fmtYen((r.unit as number | null) ?? null),
          ])
        : data.rows.map((r) => [
            String(r.locationName ?? ""),
            fmtYen((r.actualTotal as number) ?? 0),
            r.budgetTotal != null ? fmtYen(Number(r.budgetTotal)) : "-",
            fmtPct((r.achievementRate as number | null) ?? null),
            (r.progressBudgetToday as number) > 0 ? fmtYen(Number(r.progressBudgetToday)) : "-",
            fmtPct((r.progressRateToday as number | null) ?? null),
            (r.progressBudgetPrev as number) > 0 ? fmtYen(Number(r.progressBudgetPrev)) : "-",
            fmtPct((r.progressRatePrev as number | null) ?? null),
            `${Number(r.orders ?? 0).toLocaleString("ja-JP")}件`,
            r.visitors != null ? `${Number(r.visitors).toLocaleString("ja-JP")}人` : "-",
            fmtPct((r.conv as number | null) ?? null),
            fmtYen((r.atv as number | null) ?? null),
            fmtDecimal((r.setRate as number | null) ?? null, 2),
            `${Number(r.items ?? 0).toLocaleString("ja-JP")}点`,
            fmtYen((r.unit as number | null) ?? null),
          ]);

    const channelRows = data.channelRows ?? [];

    // チャネル行（POS以外のチャネル集計）
    const channelBody =
      data.view === "daily"
        ? channelRows.map((r) => [
            `[${String(r.channelName ?? "")}]`,
            fmtYen((r.actual as number) ?? 0),
            fmtYen((r.budget as number | null) ?? null),
            fmtPct((r.budgetRatio as number | null) ?? null),
            `${Number(r.orders ?? 0).toLocaleString("ja-JP")}件`,
            "-", "-",
            fmtYen((r.atv as number | null) ?? null),
            fmtDecimal((r.setRate as number | null) ?? null, 2),
            `${Number(r.items ?? 0).toLocaleString("ja-JP")}点`,
            fmtYen((r.unit as number | null) ?? null),
          ])
        : channelRows.map((r) => [
            `[${String(r.channelName ?? "")}]`,
            fmtYen((r.actualTotal as number) ?? 0),
            r.budgetTotal != null ? fmtYen(Number(r.budgetTotal)) : "-",
            fmtPct((r.achievementRate as number | null) ?? null),
            (r.progressBudgetToday as number) > 0 ? fmtYen(Number(r.progressBudgetToday)) : "-",
            fmtPct((r.progressRateToday as number | null) ?? null),
            (r.progressBudgetPrev as number) > 0 ? fmtYen(Number(r.progressBudgetPrev)) : "-",
            fmtPct((r.progressRatePrev as number | null) ?? null),
            `${Number(r.orders ?? 0).toLocaleString("ja-JP")}件`,
            "-", "-",
            fmtYen((r.atv as number | null) ?? null),
            fmtDecimal((r.setRate as number | null) ?? null, 2),
            `${Number(r.items ?? 0).toLocaleString("ja-JP")}点`,
            fmtYen((r.unit as number | null) ?? null),
          ]);

    // 各合計行
    const posRows = data.rows as Array<Record<string, unknown>>;
    const chRows = channelRows as Array<Record<string, unknown>>;
    const grandRows = [...posRows, ...chRows];

    const posTotal = data.view === "daily"
      ? buildDailyTotalRowCells(posRows, "POS合計")
      : buildPeriodTotalRowCells(posRows, "POS合計");
    const channelTotal = channelBody.length > 0
      ? (data.view === "daily"
          ? buildDailyTotalRowCells(chRows, "チャネル合計")
          : buildPeriodTotalRowCells(chRows, "チャネル合計"))
      : null;
    const grandTotal = channelBody.length > 0 && locationBody.length > 0
      ? (data.view === "daily"
          ? buildDailyTotalRowCells(grandRows, "総合計")
          : buildPeriodTotalRowCells(grandRows, "総合計"))
      : null;

    // テーブル行を構築
    // チャネルあり: 総合計 → POS合計 → POS行 → チャネル合計 → チャネル行
    // チャネルなし: POS合計 → POS行
    const result: string[][] = [];
    if (channelBody.length > 0) {
      if (grandTotal) result.push(grandTotal);
      if (posTotal && locationBody.length > 0) result.push(posTotal);
      result.push(...locationBody);
      if (channelTotal) result.push(channelTotal);
      result.push(...channelBody);
    } else {
      if (posTotal && locationBody.length > 0) result.push(posTotal);
      result.push(...locationBody);
    }
    return result;
  }, [data.hasAccess, data.view, data.rows, data.channelRows]);

  const dailyHeadings = [
    "ロケーション",
    "実績",
    "予算",
    "予算比",
    "件数",
    "入店数",
    "購買率",
    "客単価",
    "セット率",
    "点数",
    "一品単価",
  ];
  const periodHeadings = [
    "ロケーション",
    "月実績",
    "月予算",
    "達成率",
    "遂行予算(当日)",
    "遂行率(当日)",
    "遂行予算(前日)",
    "遂行率(前日)",
    "件数",
    "入店数",
    "購買率",
    "客単価",
    "セット率",
    "点数",
    "一品単価",
  ];

  return (
    <PolarisPageWrapper>
      <Page title="売上サマリー">
        <TabGroupBar tabs={REPORTS_TABS} />
        <Layout>
          {data.loadError && (
            <Layout.Section>
              <Banner tone="critical">売上サマリー読込エラー: {data.loadError}</Banner>
            </Layout.Section>
          )}
          {data.loadWarning && (
            <Layout.Section>
              <Banner tone="warning">{data.loadWarning}</Banner>
            </Layout.Section>
          )}
          {data.hasAccess && data.recomputeDailyApplied && (
            <Layout.Section>
              <Banner tone="success">
                この日の店舗行とチャネル行を、保存済みのキャッシュを使わずに取り直しました。次にページを開くときは、またキャッシュが使われます。
              </Banner>
              <Box paddingBlockStart="200">
                <Button
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete("recompute");
                    setSearchParams(next);
                  }}
                >
                  通常表示に戻す
                </Button>
              </Box>
              {recomputeDebugLocations.length > 0 && (
                <Box paddingBlockStart="200">
                  <Text tone="subdued" as="p">
                    POS（店舗行）再取得デバッグ（先頭5件）
                  </Text>
                  {recomputeDebugLocations.slice(0, 5).map((d: any) => (
                    <Text key={d.locationId ?? d.locationName} as="p">
                      {d.locationName}：POS検索取得 {d.debug?.ordersRawCount ?? "-"} → retailLocation一致 {d.debug?.ordersAtLocationCount ?? "-"}（fa78e63 方針: source_name:pos・SUCCESS）/ 件数 {d.orders}件 / 売上 {fmtYen(Number(d.actual ?? 0))}
                    </Text>
                  ))}
                  {recomputeDebugLocations.length > 5 && (
                    <Text tone="subdued" as="p">
                      ... {recomputeDebugLocations.length - 5}件分は省略しています
                    </Text>
                  )}
                </Box>
              )}
              {recomputeDebugChannels.length > 0 && (
                <Box paddingBlockStart="200">
                  <Text tone="subdued" as="p">
                    チャネル再取得デバッグ（先頭5件）
                  </Text>
                  {recomputeDebugChannels.slice(0, 5).map((d: any) => (
                    <Text key={d.channelId ?? d.channelName} as="p">
                      {d.channelName}：created {d.debug?.allCreatedOrdersCount ?? "-"} → source一致 {d.debug?.sourceNamesMatchedOrdersCount ?? "-"} / updated {d.debug?.allUpdatedOrdersCount ?? "-"} → source一致 {d.debug?.sourceNamesMatchedUpdatedOrdersCount ?? "-"} / overlay返金 {d.debug?.refundOverlayRefundCount ?? "-"} / 件数 {d.orders}件 / 売上 {fmtYen(Number(d.actual ?? 0))}
                    </Text>
                  ))}
                  {recomputeDebugChannels.length > 5 && (
                    <Text tone="subdued" as="p">
                      ... {recomputeDebugChannels.length - 5}件分は省略しています
                    </Text>
                  )}
                </Box>
              )}
            </Layout.Section>
          )}
          {data.hasAccess && data.recomputeChannelMonthApplied && (
            <Layout.Section>
              <Banner tone="success">
                表示中の月について、チャネル用の日ごとの保存データをいったん消してから集計し直しました。月次の店舗行は従来どおりです。
              </Banner>
              <Box paddingBlockStart="200">
                <Button
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete("channelNotice");
                    setSearchParams(next);
                  }}
                >
                  通常表示に戻す
                </Button>
              </Box>
            </Layout.Section>
          )}
          {!data.hasAccess && (
            <Layout.Section>
              <Banner tone="warning">{data.planMessage}</Banner>
            </Layout.Section>
          )}
          {data.hasAccess && (
            <>
              <Layout.Section>
                <SalesSummaryFilters data={data} />
              </Layout.Section>
              <Layout.Section>
                <SummaryCards period={data.view === "period"} values={tableRows.length ? [tableRows[0][1],tableRows[0][2],tableRows[0][data.view === "daily" ? 4 : 8],tableRows[0][data.view === "daily" ? 9 : 13]] : ["-","-","-","-"]} />
              </Layout.Section>
              <Layout.Section>
                <Card>
                  <Box paddingBlockEnd="400"><Text as="h2" variant="headingMd">{data.view === "period" ? "月次" : "日次"}の店舗・チャネル別実績</Text></Box>
                  {tableRows.length === 0 ? (
                    <Text tone="subdued" as="p">表示対象データがありません。</Text>
                  ) : (
                    <Box overflowX="scroll" maxWidth="100%">
                      <DataTable
                        columnContentTypes={
                          data.view === "daily"
                            ? (["text", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric"] as const)
                            : (["text", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric"] as const)
                        }
                        headings={data.view === "daily" ? dailyHeadings : periodHeadings}
                        rows={tableRows}
                      />
                    </Box>
                  )}
                </Card>
              </Layout.Section>
            </>
          )}
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}


function SalesSummaryFilters({data}: {data?: SummaryData}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const model = data ?? {
    view: searchParams.get("view") === "period" ? "period" : "daily",
    targetDate: searchParams.get("targetDate") ?? "",
    targetMonth: searchParams.get("targetMonth") ?? searchParams.get("targetDate")?.slice(0,7) ?? "",
    selectedLocationId: searchParams.get("locationId") ?? "",
    showChannels: searchParams.get("showChannels") !== "0",
    locations: searchParams.get("locationId") ? [{id: searchParams.get("locationId")!, name: "選択中のロケーション（読み込み中）"}] : [], calendarToday: "",
  };
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if(value) next.set(key,value); else next.delete(key);
    // 一度きりの再取得指定を別の条件へ引き継がない。
    next.delete("recompute"); next.delete("recomputeChannelMonth");
    if(key === "recompute" || key === "recomputeChannelMonth") next.set(key,value);
    setSearchParams(next);
  };
  return (<Card>
                  <BlockStack gap="300">
                    <InlineStack gap="300" wrap>
                      <Select
                        label="表示"
                        options={[
                          { label: "日次", value: "daily" },
                          { label: "月次", value: "period" },
                        ]}
                        value={model.view}
                        onChange={(v) => setParam("view", v)}
                      />
                      {model.view === "daily" ? (
                        <Box minWidth="220px">
                          <input
                            aria-label="対象日"
                            type="date"
                            value={model.targetDate}
                            onChange={(e) => setParam("targetDate", e.currentTarget.value)}
                            style={{ width: "100%", padding: 8 }}
                          />
                        </Box>
                      ) : (
                        <Box minWidth="220px">
                          <input
                            aria-label="対象月"
                            type="month"
                            value={model.targetMonth}
                            onChange={(e) => setParam("targetMonth", e.currentTarget.value)}
                            style={{ width: "100%", padding: 8 }}
                          />
                        </Box>
                      )}
                      <Select
                        disabled={!data}
                        label="ロケーション"
                        options={[
                          { label: "全ロケーション", value: "" },
                          ...model.locations.map((l) => ({ label: l.name, value: l.id })),
                        ]}
                        value={model.selectedLocationId}
                        onChange={(v) => setParam("locationId", v)}
                      />
                      <Select
                        label="チャネル行"
                        options={[
                          { label: "表示する", value: "1" },
                          { label: "非表示", value: "0" },
                        ]}
                        value={model.showChannels ? "1" : "0"}
                        onChange={(v) => setParam("showChannels", v)}
                      />
                      {data && model.view === "daily" && model.targetDate < model.calendarToday && (
                        <Button
                          variant="secondary"
                          onClick={() => setParam("recompute", "1")}
                        >
                          この日を再取得（古い保存を使わない）
                        </Button>
                      )}
                      {data && model.view === "period" && model.showChannels && (
                        <Button
                          variant="secondary"
                          onClick={() => setParam("recomputeChannelMonth", "1")}
                        >
                          この月のチャネルだけ保存を消してやり直す
                        </Button>
                      )}
                    </InlineStack>
                    <Text tone="subdued" as="p">
                      {!data && !model.targetDate ? "対象期間・店舗は読み込み後に表示されます。集計中も条件やメニューを変更できます。" : "管理画面では閲覧専用です（入店数報告入力はPOSタイル側で実施）。"}
                    </Text>
                  </BlockStack>
                </Card>);
}
