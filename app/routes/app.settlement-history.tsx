/**
 * /app/settlement-history — 精算・点検の履歴
 * 日付・ロケーション・金額を並べて比較する。
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useLocation, useNavigate, useSearchParams } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  Button,
  BlockStack,
  InlineStack,
  IndexTable,
  EmptyState,
  TextField,
  Select,
  Box,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, SETTLEMENT_TABS } from "../components/TabGroupBar";
import {
  buildSettlementHistoryWhere,
  dateRangeWarning,
  findSettlementLocation,
  formatExecutedAt,
  formatYen,
  isInspectionPeriod,
  normalizeHistoryDate,
  normalizeHistoryKind,
  normalizeHistoryPage,
  settlementLocationLabel,
} from "../utils/settlementHistoryQuery";

const PAGE_SIZE = 30;

function statusBadge(status: string) {
  switch (status) {
    case "completed":
      return <Badge tone="success">完了</Badge>;
    case "printed":
      return <Badge tone="success">印字済</Badge>;
    case "draft":
      return <Badge tone="info">下書き</Badge>;
    case "failed":
      return <Badge tone="critical">失敗</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

function kindBadge(isInspection: boolean) {
  return isInspection ? <Badge tone="attention">点検</Badge> : <Badge>精算</Badge>;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const url = new URL(request.url);
  const dateFrom = normalizeHistoryDate(url.searchParams.get("dateFrom"));
  const dateTo = normalizeHistoryDate(url.searchParams.get("dateTo"));
  const locationId = (url.searchParams.get("locationId") ?? "").trim();
  const kind = normalizeHistoryKind(url.searchParams.get("kind"));
  const page = normalizeHistoryPage(url.searchParams.get("page"));
  const timeZone = await getShopTimezoneForDaily(admin, shop.id);

  const dbLocations = await prisma.location.findMany({
    where: { shopId: shop.id },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      shopifyLocationGid: true,
      name: true,
      displayName: true,
    },
  });
  const where = buildSettlementHistoryWhere({
    shopId: shop.id,
    dateFrom,
    dateTo,
    locationId,
    kind,
  });

  const [total, items] = await Promise.all([
    prisma.settlement.count({ where }),
    prisma.settlement.findMany({
      where,
      orderBy: [{ targetDate: "desc" }, { locationId: "asc" }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        targetDate: true,
        periodLabel: true,
        locationId: true,
        total: true,
        netSales: true,
        refundTotal: true,
        orderCount: true,
        refundCount: true,
        itemCount: true,
        status: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    items: items.map((row) => {
      const place = settlementLocationLabel(
        findSettlementLocation(dbLocations, row.locationId),
        row.locationId,
      );
      const inspection = isInspectionPeriod(row.periodLabel);
      return {
        id: row.id,
        targetDate: row.targetDate,
        locationLabel: place.label,
        locationTitle: place.title,
        total: formatYen(row.total.toString()),
        netSales: formatYen(row.netSales.toString()),
        refundTotal: formatYen(row.refundTotal.toString()),
        orderCount: row.orderCount,
        refundCount: row.refundCount,
        itemCount: row.itemCount,
        status: row.status,
        isInspection: inspection,
        executedAt: formatExecutedAt(row.createdAt.toISOString(), timeZone),
      };
    }),
    locations: dbLocations.map((row) => ({
      id: row.shopifyLocationGid,
      label: settlementLocationLabel(row, row.shopifyLocationGid).label,
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
    dateFrom,
    dateTo,
    locationId: findSettlementLocation(dbLocations, locationId)?.shopifyLocationGid ?? locationId,
    kind,
    timeZone,
    rangeWarning: dateRangeWarning(dateFrom, dateTo),
  };
}

export default function SettlementHistoryPage() {
  const data = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const q = location.search || "";
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const hasFilter = Boolean(data.dateFrom || data.dateTo || data.locationId || data.kind !== "all");

  const handleFilter = (key: string, value: string) => {
    const params = new URLSearchParams(location.search);
    if (value) params.set(key, value);
    else params.delete(key);
    params.set("page", "1");
    setSearchParams(params);
  };

  const clearFilters = () => {
    const params = new URLSearchParams(location.search);
    for (const key of ["dateFrom", "dateTo", "locationId", "kind", "page"]) params.delete(key);
    setSearchParams(params);
  };

  const gotoPage = (nextPage: number) => {
    const params = new URLSearchParams(location.search);
    params.set("page", String(nextPage));
    setSearchParams(params);
  };

  const locationOptions = [
    { label: "すべてのロケーション", value: "" },
    ...data.locations.map((row) => ({ label: row.label, value: row.id })),
  ];
  if (data.locationId && !data.locations.some((row) => row.id === data.locationId)) {
    locationOptions.push({ label: "未登録のロケーション", value: data.locationId });
  }

  const emptyHeading = hasFilter ? "条件に一致する履歴がありません" : "精算履歴がありません";

  const rows = data.items.map((item, index) => (
    <IndexTable.Row id={item.id} key={item.id} position={index}>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          {item.targetDate}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{kindBadge(item.isInspection)}</IndexTable.Cell>
      <IndexTable.Cell>
        <span className="AdminHistory-location" title={item.locationTitle}>
          {item.locationLabel}
        </span>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <span className="AdminMoney">{item.total}</span>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <span className="AdminMoney">{item.netSales}</span>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <span className="AdminMoney">{item.refundTotal}</span>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd">
          {item.orderCount}件・{item.refundCount}返・{item.itemCount}点
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{statusBadge(item.status)}</IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd">
          {item.executedAt}
        </Text>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <PolarisPageWrapper>
      <Page title="精算履歴" fullWidth backAction={{ content: "戻る", onAction: () => navigate("/app" + q) }}>
        <div className="AdminHistory">
          <Card padding="0">
            <TabGroupBar tabs={SETTLEMENT_TABS} />
          </Card>
          <Layout>
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text variant="headingSm" as="h2">
                    絞り込み
                  </Text>
                  <Text as="p" tone="subdued">
                    日付、ロケーション、総売上、純売上、返金を比較できます。印字は Shopify Printing API です。実行日時は {data.timeZone} です。
                  </Text>
                  {data.rangeWarning ? <Banner tone="warning">{data.rangeWarning}</Banner> : null}
                  <div className="AdminHistory-filters">
                    <TextField
                      label="開始日"
                      type="date"
                      value={data.dateFrom}
                      onChange={(value) => handleFilter("dateFrom", value)}
                      autoComplete="off"
                    />
                    <TextField
                      label="終了日"
                      type="date"
                      value={data.dateTo}
                      onChange={(value) => handleFilter("dateTo", value)}
                      autoComplete="off"
                    />
                    <Select
                      label="ロケーション"
                      options={locationOptions}
                      value={data.locationId}
                      onChange={(value) => handleFilter("locationId", value)}
                    />
                    <Select
                      label="区分"
                      options={[
                        { label: "精算と点検", value: "all" },
                        { label: "精算", value: "settlement" },
                        { label: "点検", value: "inspection" },
                      ]}
                      value={data.kind}
                      onChange={(value) => handleFilter("kind", value)}
                    />
                    {hasFilter ? (
                      <Button onClick={clearFilters}>条件をクリア</Button>
                    ) : null}
                  </div>
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section>
              <div className="AdminHistory-table">
                <Card padding="0">
                  <IndexTable
                    resourceName={{ singular: "精算", plural: "精算" }}
                    itemCount={data.items.length}
                    headings={[
                      { title: "対象日" },
                      { title: "区分" },
                      { title: "ロケーション" },
                      { title: "総売上", alignment: "end" },
                      { title: "純売上", alignment: "end" },
                      { title: "返金", alignment: "end" },
                      { title: "件数" },
                      { title: "状態" },
                      { title: "実行日時" },
                    ]}
                    selectable={false}
                    emptyState={
                      <EmptyState heading={emptyHeading} image="">
                        <Text as="p" tone="subdued">
                          POSの精算タイルから精算または点検を実行すると、ここに履歴が表示されます。
                        </Text>
                      </EmptyState>
                    }
                  >
                    {rows}
                  </IndexTable>
                </Card>
              </div>
              <div className="AdminHistory-cards">
                <Card padding="0">
                  {data.items.length === 0 ? (
                    <Box padding="400">
                      <BlockStack gap="200">
                        <Text as="h2" variant="headingMd">
                          {emptyHeading}
                        </Text>
                        <Text as="p" tone="subdued">
                          POSの精算タイルから精算または点検を実行すると、ここに履歴が表示されます。
                        </Text>
                      </BlockStack>
                    </Box>
                  ) : (
                    data.items.map((item) => (
                      <article key={item.id} className="AdminHistory-card">
                        <div className="AdminHistory-card-head">
                          <Text as="h3" variant="bodyMd" fontWeight="semibold">
                            {item.targetDate}
                          </Text>
                          {kindBadge(item.isInspection)}
                        </div>
                        <p className="AdminHistory-location" title={item.locationTitle}>
                          {item.locationLabel}
                        </p>
                        <dl className="AdminHistory-amounts">
                          <div>
                            <dt>総売上</dt>
                            <dd>{item.total}</dd>
                          </div>
                          <div>
                            <dt>純売上</dt>
                            <dd>{item.netSales}</dd>
                          </div>
                          <div>
                            <dt>返金</dt>
                            <dd>{item.refundTotal}</dd>
                          </div>
                        </dl>
                        <div className="AdminHistory-card-meta">
                          <Text as="span" variant="bodyMd">
                            {item.orderCount}件・{item.refundCount}返・{item.itemCount}点
                          </Text>
                          {statusBadge(item.status)}
                        </div>
                        <Text as="p" tone="subdued">
                          実行日時 {item.executedAt}
                        </Text>
                      </article>
                    ))
                  )}
                </Card>
              </div>
            </Layout.Section>

            <Layout.Section>
              <Box paddingBlockEnd="400">
                <InlineStack align="center" gap="200">
                  <Button disabled={data.page <= 1} onClick={() => gotoPage(data.page - 1)} size="slim">
                    前のページ
                  </Button>
                  <Text as="span" variant="bodyMd">
                    {data.page} / {totalPages}ページ（全{data.total}件）
                  </Text>
                  <Button
                    disabled={data.page >= totalPages}
                    onClick={() => gotoPage(data.page + 1)}
                    size="slim"
                  >
                    次のページ
                  </Button>
                </InlineStack>
              </Box>
            </Layout.Section>
          </Layout>
        </div>
      </Page>
    </PolarisPageWrapper>
  );
}
