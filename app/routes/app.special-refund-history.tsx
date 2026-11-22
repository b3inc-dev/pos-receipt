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
  EmptyState,
  Box,
  Select,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, SETTLEMENT_TABS } from "../components/TabGroupBar";
import { DateFilter } from "../components/DateFilter";

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

function shopifyRefundBadge(status: string) {
  const map: Record<string, { tone: "success" | "warning" | "info" | "critical"; label: string }> = {
    success: { tone: "success", label: "Shopify返金済" },
    failed: { tone: "critical", label: "Shopify返金失敗" },
    skipped: { tone: "info", label: "記録のみ" },
    pending: { tone: "warning", label: "返金処理中" },
    none: { tone: "info", label: "—" },
  };
  const item = map[status];
  if (!item || status === "none") return <Text as="span" tone="subdued">—</Text>;
  return <Badge tone={item.tone}>{item.label}</Badge>;
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
        shopifyRefundStatus: true,
        shopifyRefundError: true,
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
      shopifyRefundStatus: e.shopifyRefundStatus,
      shopifyRefundError: e.shopifyRefundError,
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

  return (
    <PolarisPageWrapper>
      <Page
        title="特殊返金・商品券調整 履歴"
        backAction={{ content: "戻る", onAction: to("/app") }}
      >
        <Card padding="0">
          <TabGroupBar tabs={SETTLEMENT_TABS} />
        </Card>
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
                  {/* 日付欄は共通の CSS（Admin-input）で枠からはみ出さないようにする（UI ルール v1.1 6章・13章） */}
                  <DateFilter id="special-refund-history-from" label="開始日" value={dateFrom} onChange={(v) => handleFilter("dateFrom", v)} />
                  <DateFilter id="special-refund-history-to" label="終了日" value={dateTo} onChange={(v) => handleFilter("dateTo", v)} />
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* テーブル */}
          <Layout.Section>
            <Card padding="0">
              {items.length === 0 ? (
                <EmptyState heading="特殊返金・調整履歴がありません" image="">
                  <Text as="p" tone="subdued">
                    POSの特殊返金タイルからイベントを登録すると、ここに履歴が表示されます。
                  </Text>
                </EmptyState>
              ) : (
                // スマホでは横スクロールさせず 1 件 1 枚のカードにする（data-label が各行の見出し。UI ルール v1.1 8章）
                <div className="History-scroll">
                  <table className="History-table">
                    <thead>
                      <tr>
                        <th scope="col">取引</th>
                        <th scope="col">種別</th>
                        <th scope="col" className="History-num">金額</th>
                        <th scope="col">返金手段変更</th>
                        <th scope="col">備考</th>
                        <th scope="col">ステータス</th>
                        <th scope="col">Shopify返金</th>
                        <th scope="col">登録日時</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.id}>
                          <td data-label="取引" className="History-id">
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
                          </td>
                          <td data-label="種別" className="History-keep">{eventTypeLabel(item.eventType)}</td>
                          <td data-label="金額" className="History-num">{fmtYen(item.amount)}</td>
                          <td data-label="返金手段変更">
                            {item.originalPaymentMethod && item.actualRefundMethod
                              ? `${item.originalPaymentMethod} → ${item.actualRefundMethod}`
                              : item.voucherFaceValue
                              ? `額面: ${fmtYen(item.voucherFaceValue)}`
                              : "—"}
                          </td>
                          <td data-label="備考" className="History-text">
                            <Text as="span" variant="bodySm" tone="subdued">
                              {item.note ?? "—"}
                            </Text>
                          </td>
                          <td data-label="ステータス" className="History-keep">{statusBadge(item.status)}</td>
                          <td data-label="Shopify返金">
                            <BlockStack gap="100">
                              {shopifyRefundBadge(item.shopifyRefundStatus)}
                              {item.shopifyRefundStatus === "failed" && item.shopifyRefundError ? (
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {item.shopifyRefundError}
                                </Text>
                              ) : null}
                            </BlockStack>
                          </td>
                          <td data-label="登録日時" className="History-keep">
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
