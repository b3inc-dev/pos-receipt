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
  EmptyState,
  TextField,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, RECEIPT_TABS } from "../components/TabGroupBar";
import { DateFilter } from "../components/DateFilter";

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

  return (
    <PolarisPageWrapper>
      <Page
        title="領収書発行履歴"
        backAction={{ content: "戻る", onAction: to("/app") }}
      >
        <Card padding="0">
          <TabGroupBar tabs={RECEIPT_TABS} />
        </Card>
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
                  {/* 日付欄は共通の CSS（Admin-input）で枠からはみ出さないようにする（UI ルール v1.1 6章・13章） */}
                  <DateFilter id="receipt-history-from" label="開始日" value={dateFrom} onChange={(v) => handleFilter("dateFrom", v)} />
                  <DateFilter id="receipt-history-to" label="終了日" value={dateTo} onChange={(v) => handleFilter("dateTo", v)} />
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* テーブル */}
          <Layout.Section>
            <Card padding="0">
              {items.length === 0 ? (
                <EmptyState heading="領収書発行履歴がありません" image="">
                  <Text as="p" tone="subdued">
                    POSの領収書タイルから領収書を発行すると、ここに履歴が表示されます。
                  </Text>
                </EmptyState>
              ) : (
                // スマホでは横スクロールさせず 1 件 1 枚のカードにする（data-label が各行の見出し。UI ルール v1.1 8章）
                <div className="History-scroll">
                  <table className="History-table">
                    <thead>
                      <tr>
                        <th scope="col">取引</th>
                        <th scope="col">宛名</th>
                        <th scope="col">但し書き</th>
                        <th scope="col" className="History-num">金額</th>
                        <th scope="col">種別</th>
                        <th scope="col">担当</th>
                        <th scope="col">発行日時</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.id}>
                          <td data-label="取引" className="History-id">
                            <Text as="span" variant="bodyMd" fontWeight="semibold">
                              {item.orderName ?? item.orderId}
                            </Text>
                          </td>
                          <td data-label="宛名" className="History-text">{item.recipientName ?? "—"}</td>
                          <td data-label="但し書き" className="History-text">
                            <Text as="span" variant="bodySm" tone="subdued">
                              {item.proviso ?? "—"}
                            </Text>
                          </td>
                          <td data-label="金額" className="History-num">{fmtYen(item.amount)}</td>
                          <td data-label="種別" className="History-keep">
                            {item.isReissue
                              ? <Badge tone="attention">再発行</Badge>
                              : <Badge tone="success">新規発行</Badge>}
                          </td>
                          <td data-label="担当">
                            <Text as="span" variant="bodySm" tone="subdued">
                              {item.createdBy ?? "—"}
                            </Text>
                          </td>
                          <td data-label="発行日時" className="History-keep">
                            <Text as="span" variant="bodySm" tone="subdued">
                              {new Date(item.createdAt).toLocaleString("ja-JP", {
                                year: "numeric", month: "2-digit", day: "2-digit",
                                hour: "2-digit", minute: "2-digit",
                              })}
                            </Text>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
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
