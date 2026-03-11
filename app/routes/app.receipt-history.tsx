/**
 * /app/receipt-history — 領収書発行履歴
 * 要件書 §19.3: 管理画面 - 領収書発行履歴・再発行履歴
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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

const PAGE_SIZE = 30;

function fmtYen(n: string | number) {
  return `¥${Number(n).toLocaleString("ja-JP")}`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const url = new URL(request.url);
  const dateFrom   = url.searchParams.get("dateFrom")   ?? "";
  const dateTo     = url.searchParams.get("dateTo")     ?? "";
  const orderName  = url.searchParams.get("orderName")  ?? "";
  const page       = Math.max(1, Number(url.searchParams.get("page") ?? "1"));

  const whereClean = {
    shopId: shop.id,
    ...(orderName ? { orderName: { contains: orderName } } : {}),
    ...(dateFrom || dateTo
      ? {
          createdAt: {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo   ? { lte: new Date(dateTo + "T23:59:59Z") } : {}),
          },
        }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.receiptIssue.count({ where: whereClean }),
    prisma.receiptIssue.findMany({
      where: whereClean,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        orderId: true,
        orderName: true,
        locationId: true,
        recipientName: true,
        proviso: true,
        amount: true,
        currency: true,
        templateVersion: true,
        isReissue: true,
        createdBy: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    items: items.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      orderName: r.orderName,
      locationId: r.locationId,
      recipientName: r.recipientName,
      proviso: r.proviso,
      amount: r.amount.toString(),
      currency: r.currency ?? "JPY",
      templateVersion: r.templateVersion,
      isReissue: r.isReissue,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
    dateFrom,
    dateTo,
    orderName,
  };
}

export default function ReceiptHistoryPage() {
  const { items, total, page, pageSize, dateFrom, dateTo, orderName } =
    useLoaderData<typeof loader>();
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

  const resourceName = { singular: "領収書", plural: "領収書" };

  return (
    <PolarisPageWrapper>
      <Page
        title="領収書発行履歴"
        backAction={{ content: "戻る", onAction: to("/app") }}
      >
        <Layout>
          {/* フィルター */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" as="h2">絞り込み</Text>
                <InlineStack gap="300" align="start" wrap>
                  <Box minWidth="200px">
                    <TextField
                      label="注文番号"
                      value={orderName}
                      onChange={(v) => handleFilter("orderName", v)}
                      placeholder="#1001"
                      autoComplete="off"
                    />
                  </Box>
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
                  { title: "取引" },
                  { title: "宛名" },
                  { title: "但し書き" },
                  { title: "金額" },
                  { title: "種別" },
                  { title: "担当" },
                  { title: "発行日時" },
                ]}
                selectable={false}
                emptyState={
                  <EmptyState
                    heading="領収書発行履歴がありません"
                    image=""
                  >
                    <Text as="p" tone="subdued">
                      POSの領収書タイルから領収書を発行すると、ここに履歴が表示されます。
                    </Text>
                  </EmptyState>
                }
              >
                {items.map((item, idx) => (
                  <IndexTable.Row id={item.id} key={item.id} position={idx}>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {item.orderName ?? item.orderId}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {item.recipientName ?? "—"}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {item.proviso ?? "—"}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{fmtYen(item.amount)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {item.isReissue
                        ? <Badge tone="attention">再発行</Badge>
                        : <Badge tone="success">新規発行</Badge>}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {item.createdBy ?? "—"}
                      </Text>
                    </IndexTable.Cell>
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
                  <Button disabled={page <= 1} onClick={() => gotoPage(page - 1)} size="slim">
                    前のページ
                  </Button>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {page} / {totalPages}ページ（計{total}件）
                  </Text>
                  <Button disabled={page >= totalPages} onClick={() => gotoPage(page + 1)} size="slim">
                    次のページ
                  </Button>
                </InlineStack>
              </Box>
            </Layout.Section>
          )}

          {totalPages <= 1 && total > 0 && (
            <Layout.Section>
              <Text as="p" tone="subdued" alignment="center">全{total}件</Text>
            </Layout.Section>
          )}
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
