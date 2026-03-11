/**
 * /app/settlement-history — 精算履歴
 * 要件書 §19.3: 管理画面 - 精算履歴一覧・ステータス確認
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
  Box,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

const PAGE_SIZE = 30;

function statusBadge(status: string, isInspection: boolean) {
  if (isInspection) return <Badge tone="attention">点検</Badge>;
  switch (status) {
    case "completed": return <Badge tone="success">完了</Badge>;
    case "printed":   return <Badge tone="success">印字済</Badge>;
    case "draft":     return <Badge tone="info">下書き</Badge>;
    case "failed":    return <Badge tone="critical">失敗</Badge>;
    default:          return <Badge>{status}</Badge>;
  }
}

function printModeLabel(mode: string) {
  return mode === "cloudprnt_direct" ? "CloudPRNT" : "注文経由";
}

function fmtYen(n: string | number) {
  return `¥${Number(n).toLocaleString("ja-JP")}`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const url = new URL(request.url);
  const dateFrom = url.searchParams.get("dateFrom") ?? "";
  const dateTo   = url.searchParams.get("dateTo")   ?? "";
  const page     = Math.max(1, Number(url.searchParams.get("page") ?? "1"));

  const where = {
    shopId: shop.id,
    ...(dateFrom && { targetDate: { gte: dateFrom } }),
    ...(dateTo   && { targetDate: dateTo ? { ...(dateFrom ? { gte: dateFrom } : {}), lte: dateTo } : undefined }),
  } as Parameters<typeof prisma.settlement.findMany>[0]["where"];

  // dateFrom + dateTo 両方ある場合は上書き
  const whereClean = {
    shopId: shop.id,
    ...(dateFrom || dateTo
      ? {
          targetDate: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo   ? { lte: dateTo }   : {}),
          },
        }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.settlement.count({ where: whereClean }),
    prisma.settlement.findMany({
      where: whereClean,
      orderBy: [{ targetDate: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        targetDate: true,
        periodLabel: true,
        locationId: true,
        total: true,
        netSales: true,
        orderCount: true,
        refundCount: true,
        itemCount: true,
        printMode: true,
        status: true,
        sourceOrderName: true,
        printedAt: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    items: items.map((s) => ({
      id: s.id,
      targetDate: s.targetDate,
      periodLabel: s.periodLabel ?? s.targetDate,
      locationId: s.locationId,
      total: s.total.toString(),
      netSales: s.netSales.toString(),
      orderCount: s.orderCount,
      refundCount: s.refundCount,
      itemCount: s.itemCount,
      printMode: s.printMode,
      status: s.status,
      sourceOrderName: s.sourceOrderName,
      printedAt: s.printedAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
      isInspection: s.periodLabel?.startsWith("点検_") ?? false,
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
    dateFrom,
    dateTo,
  };
}

export default function SettlementHistoryPage() {
  const { items, total, page, pageSize, dateFrom, dateTo } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const q = location.search || "";
  const to = (path: string) => () => navigate(path + q);

  const totalPages = Math.ceil(total / pageSize);

  const handleFilter = (key: string, value: string) => {
    const params = new URLSearchParams(location.search);
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    params.set("page", "1");
    setSearchParams(params);
  };

  const gotoPage = (p: number) => {
    const params = new URLSearchParams(location.search);
    params.set("page", String(p));
    setSearchParams(params);
  };

  const resourceName = { singular: "精算", plural: "精算" };

  return (
    <PolarisPageWrapper>
      <Page
        title="精算履歴"
        backAction={{ content: "戻る", onAction: to("/app") }}
      >
        <Layout>
          {/* フィルター */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" as="h2">絞り込み</Text>
                <InlineStack gap="300" align="start">
                  <Box minWidth="160px">
                    <TextField
                      label="開始日"
                      type="date"
                      value={dateFrom}
                      onChange={(v) => handleFilter("dateFrom", v)}
                      autoComplete="off"
                    />
                  </Box>
                  <Box minWidth="160px">
                    <TextField
                      label="終了日"
                      type="date"
                      value={dateTo}
                      onChange={(v) => handleFilter("dateTo", v)}
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* テーブル */}
          <Layout.Section>
            <Card padding="0">
              <IndexTable
                resourceName={resourceName}
                itemCount={items.length}
                headings={[
                  { title: "対象日" },
                  { title: "ロケーション" },
                  { title: "総売上" },
                  { title: "純売上" },
                  { title: "件数" },
                  { title: "印字方式" },
                  { title: "ステータス" },
                  { title: "実行日時" },
                ]}
                selectable={false}
                emptyState={
                  <EmptyState
                    heading="精算履歴がありません"
                    image=""
                  >
                    <Text as="p" tone="subdued">
                      POSの精算タイルから精算を実行すると、ここに履歴が表示されます。
                    </Text>
                  </EmptyState>
                }
              >
                {items.map((item, idx) => (
                  <IndexTable.Row id={item.id} key={item.id} position={idx}>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {item.targetDate}
                      </Text>
                      {item.isInspection && (
                        <Box paddingInlineStart="100" as="span">
                          <Badge tone="attention" size="small">点検</Badge>
                        </Box>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {item.locationId.split("/").pop() ?? item.locationId}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{fmtYen(item.total)}</IndexTable.Cell>
                    <IndexTable.Cell>{fmtYen(item.netSales)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {item.orderCount}件 / {item.refundCount}返 / {item.itemCount}点
                    </IndexTable.Cell>
                    <IndexTable.Cell>{printModeLabel(item.printMode)}</IndexTable.Cell>
                    <IndexTable.Cell>{statusBadge(item.status, item.isInspection)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {new Date(item.createdAt).toLocaleString("ja-JP", {
                          year: "numeric", month: "2-digit", day: "2-digit",
                          hour: "2-digit", minute: "2-digit",
                        })}
                      </Text>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>
          </Layout.Section>

          {/* ページネーション */}
          {totalPages > 1 && (
            <Layout.Section>
              <Box paddingBlockEnd="400">
                <InlineStack align="center" gap="200">
                  <Button
                    disabled={page <= 1}
                    onClick={() => gotoPage(page - 1)}
                    size="slim"
                  >
                    前のページ
                  </Button>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {page} / {totalPages}ページ（計{total}件）
                  </Text>
                  <Button
                    disabled={page >= totalPages}
                    onClick={() => gotoPage(page + 1)}
                    size="slim"
                  >
                    次のページ
                  </Button>
                </InlineStack>
              </Box>
            </Layout.Section>
          )}

          {totalPages <= 1 && total > 0 && (
            <Layout.Section>
              <Text as="p" tone="subdued" alignment="center">
                全{total}件
              </Text>
            </Layout.Section>
          )}
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
