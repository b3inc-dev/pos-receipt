/**
 * /app/special-refund-history — 特殊返金・商品券調整 履歴
 * 要件書 §19.3: 管理画面 - 特殊返金履歴一覧・取引別確認
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
  Select,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

const PAGE_SIZE = 30;

const EVENT_TYPE_OPTIONS = [
  { label: "すべて", value: "" },
  { label: "現金返金", value: "cash_refund" },
  { label: "返金手段変更", value: "payment_method_override" },
  { label: "商品券調整", value: "voucher_change_adjustment" },
  { label: "レシート現金調整", value: "receipt_cash_adjustment" },
];

function eventTypeLabel(t: string) {
  const map: Record<string, string> = {
    cash_refund: "現金返金",
    payment_method_override: "返金手段変更",
    voucher_change_adjustment: "商品券調整",
    receipt_cash_adjustment: "レシート現金調整",
  };
  return map[t] ?? t;
}

function statusBadge(status: string) {
  return status === "voided"
    ? <Badge tone="critical">無効</Badge>
    : <Badge tone="success">有効</Badge>;
}

function fmtYen(n: string | number) {
  return `¥${Number(n).toLocaleString("ja-JP")}`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const url = new URL(request.url);
  const dateFrom  = url.searchParams.get("dateFrom")  ?? "";
  const dateTo    = url.searchParams.get("dateTo")    ?? "";
  const eventType = url.searchParams.get("eventType") ?? "";
  const page      = Math.max(1, Number(url.searchParams.get("page") ?? "1"));

  const whereClean = {
    shopId: shop.id,
    ...(eventType ? { eventType } : {}),
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
    prisma.specialRefundEvent.count({ where: whereClean }),
    prisma.specialRefundEvent.findMany({
      where: whereClean,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        sourceOrderId: true,
        sourceOrderName: true,
        locationId: true,
        eventType: true,
        amount: true,
        currency: true,
        originalPaymentMethod: true,
        actualRefundMethod: true,
        voucherFaceValue: true,
        voucherChangeAmount: true,
        note: true,
        createdBy: true,
        status: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    items: items.map((e) => ({
      id: e.id,
      sourceOrderId: e.sourceOrderId,
      sourceOrderName: e.sourceOrderName,
      locationId: e.locationId,
      eventType: e.eventType,
      amount: e.amount.toString(),
      currency: e.currency ?? "JPY",
      originalPaymentMethod: e.originalPaymentMethod,
      actualRefundMethod: e.actualRefundMethod,
      voucherFaceValue: e.voucherFaceValue?.toString() ?? null,
      voucherChangeAmount: e.voucherChangeAmount?.toString() ?? null,
      note: e.note,
      createdBy: e.createdBy,
      status: e.status,
      createdAt: e.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
    dateFrom,
    dateTo,
    eventType,
  };
}

export default function SpecialRefundHistoryPage() {
  const { items, total, page, pageSize, dateFrom, dateTo, eventType } =
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

  const resourceName = { singular: "イベント", plural: "イベント" };

  return (
    <PolarisPageWrapper>
      <Page
        title="特殊返金・商品券調整 履歴"
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
                    <Select
                      label="イベント種別"
                      options={EVENT_TYPE_OPTIONS}
                      value={eventType}
                      onChange={(v) => handleFilter("eventType", v)}
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
                  { title: "種別" },
                  { title: "金額" },
                  { title: "返金手段変更" },
                  { title: "備考" },
                  { title: "ステータス" },
                  { title: "登録日時" },
                ]}
                selectable={false}
                emptyState={
                  <EmptyState
                    heading="特殊返金・調整履歴がありません"
                    image=""
                  >
                    <Text as="p" tone="subdued">
                      POSの特殊返金タイルからイベントを登録すると、ここに履歴が表示されます。
                    </Text>
                  </EmptyState>
                }
              >
                {items.map((item, idx) => (
                  <IndexTable.Row id={item.id} key={item.id} position={idx}>
                    <IndexTable.Cell>
                      <BlockStack gap="100">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {item.sourceOrderName ?? item.sourceOrderId}
                        </Text>
                        {item.createdBy && (
                          <Text as="span" variant="bodySm" tone="subdued">
                            担当: {item.createdBy}
                          </Text>
                        )}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {eventTypeLabel(item.eventType)}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {fmtYen(item.amount)}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {item.originalPaymentMethod && item.actualRefundMethod
                        ? `${item.originalPaymentMethod} → ${item.actualRefundMethod}`
                        : item.voucherFaceValue
                        ? `額面: ${fmtYen(item.voucherFaceValue)}`
                        : "—"}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {item.note ?? "—"}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{statusBadge(item.status)}</IndexTable.Cell>
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
