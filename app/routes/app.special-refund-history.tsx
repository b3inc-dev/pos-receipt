/**
 * /app/special-refund-history — 特殊返金・商品券調整 履歴
 * 要件書 §19.3: 管理画面 - 特殊返金履歴一覧・取引別確認
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useLocation, useNavigate, useSearchParams } from "react-router";
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
import { TabGroupBar, SETTLEMENT_TABS } from "../components/TabGroupBar";
import { ConfirmAction, StatusBanner, SuccessToast } from "../components/admin-ui";
import { decideSpecialRefundApproval } from "../services/specialRefundApproval.server";
import {
  approvalDecidedByLabel,
  normalizeApprovalStatus,
  resolveApprovalDecidedBy,
} from "../utils/specialRefundApproval";

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

const APPROVAL_FILTER_OPTIONS = [
  { label: "すべて", value: "" },
  { label: "承認待ち", value: "pending" },
  { label: "承認済み", value: "approved" },
  { label: "却下", value: "rejected" },
];

function approvalBadge(approvalStatus: string) {
  switch (normalizeApprovalStatus(approvalStatus)) {
    case "pending":
      return <Badge tone="warning">承認待ち</Badge>;
    case "approved":
      return <Badge tone="success">承認済み</Badge>;
    case "rejected":
      return <Badge>却下</Badge>;
    default:
      return <Text as="span" tone="subdued">—</Text>;
  }
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
  const approvalRaw = url.searchParams.get("approval") ?? "";
  const approval = APPROVAL_FILTER_OPTIONS.some((o) => o.value === approvalRaw) ? approvalRaw : "";
  const page      = Math.max(1, Number(url.searchParams.get("page") ?? "1"));

  const whereClean = {
    shopId: shop.id,
    ...(eventType ? { eventType } : {}),
    ...(approval ? { approvalStatus: approval } : {}),
    ...(dateFrom || dateTo
      ? {
          createdAt: {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo   ? { lte: new Date(dateTo + "T23:59:59Z") } : {}),
          },
        }
      : {}),
  };

  const [total, items, pendingApprovalCount] = await Promise.all([
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
        approvalStatus: true,
        approvalReviewedAt: true,
        approvalDecidedBy: true,
        createdAt: true,
      },
    }),
    prisma.specialRefundEvent.count({
      where: { shopId: shop.id, status: "active", approvalStatus: "pending" },
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
      approvalStatus: e.approvalStatus,
      approvalReviewedAt: e.approvalReviewedAt?.toISOString() ?? null,
      approvalDecidedBy: approvalDecidedByLabel(e.approvalDecidedBy),
      createdAt: e.createdAt.toISOString(),
    })),
    pendingApprovalCount,
    approval,
    total,
    page,
    pageSize: PAGE_SIZE,
    dateFrom,
    dateTo,
    eventType,
  };
}

/** 返金手段変更の承認／却下（設定「管理者の承認」がオンのときに承認待ちになったもの）。Shopify には何も書かない */
export async function action({ request }: ActionFunctionArgs) {
  const auth = await authenticate.admin(request);
  const { admin, session } = auth;
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  if (formData.get("intent") !== "approval") {
    return { ok: false as const, message: "この操作は受け付けていません。画面を読み直してください。" };
  }
  const eventId = String(formData.get("eventId") ?? "");
  if (!eventId) {
    return { ok: false as const, message: "登録が見つかりません。画面を読み直してください。" };
  }
  const result = await decideSpecialRefundApproval(
    admin,
    shop.id,
    eventId,
    formData.get("decision"),
    resolveApprovalDecidedBy(auth),
  );
  if (!result.ok) return { ok: false as const, message: result.message };
  const order = result.sourceOrderName ?? "この登録";
  return {
    ok: true as const,
    message: result.decision === "approved" ? `${order} を承認しました` : `${order} を却下しました`,
    settlementAlreadyConfirmed: result.settlementAlreadyConfirmed,
    eventId: result.eventId,
    at: Date.now(),
  };
}

export default function SpecialRefundHistoryPage() {
  const { items, total, page, pageSize, dateFrom, dateTo, eventType, approval, pendingApprovalCount } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
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
        <Card padding="0">
          <TabGroupBar tabs={SETTLEMENT_TABS} />
        </Card>
        <Layout>
          <SuccessToast message={actionData?.ok ? actionData.message : null} trigger={actionData} />
          {(() => {
            // お知らせ枠は 1 つだけ（UI ルール 5 章）: 失敗 → 注意 → 案内の順
            if (actionData && !actionData.ok) {
              return (
                <Layout.Section>
                  <StatusBanner tone="critical" heading="承認・却下できませんでした">
                    {actionData.message}
                  </StatusBanner>
                </Layout.Section>
              );
            }
            if (actionData?.ok && actionData.settlementAlreadyConfirmed) {
              return (
                <Layout.Section>
                  <StatusBanner tone="warning" heading="この日の精算はもう確定しています">
                    確定した精算の金額は変わりません。直すときは POS の精算で再確定してください。売上サマリーは直しました。
                  </StatusBanner>
                </Layout.Section>
              );
            }
            if (pendingApprovalCount > 0 && approval !== "pending") {
              return (
                <Layout.Section>
                  <StatusBanner tone="info" heading={`承認待ちの返金手段変更が ${pendingApprovalCount} 件あります`}>
                    承認するまで精算・売上サマリーに入りません。「承認」で絞り込むと一覧で確かめられます。
                  </StatusBanner>
                </Layout.Section>
              );
            }
            return null;
          })()}
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
                    <Select
                      label="承認"
                      options={APPROVAL_FILTER_OPTIONS}
                      value={approval}
                      onChange={(v) => handleFilter("approval", v)}
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
                  { title: "Shopify返金" },
                  { title: "承認" },
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
                      <BlockStack gap="100">
                        {shopifyRefundBadge(item.shopifyRefundStatus)}
                        {item.shopifyRefundStatus === "failed" && item.shopifyRefundError ? (
                          <Text as="span" variant="bodySm" tone="subdued">
                            {item.shopifyRefundError}
                          </Text>
                        ) : null}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="100">
                        {approvalBadge(item.approvalStatus)}
                        {item.approvalReviewedAt ? (
                          <Text as="span" variant="bodySm" tone="subdued">
                            {new Date(item.approvalReviewedAt).toLocaleString("ja-JP", {
                              timeZone: "Asia/Tokyo",
                              year: "numeric", month: "2-digit", day: "2-digit",
                              hour: "2-digit", minute: "2-digit",
                            })}
                            {" "}
                            {item.approvalDecidedBy ?? "（決めた人は取れませんでした）"}
                          </Text>
                        ) : null}
                        {item.status === "active" && normalizeApprovalStatus(item.approvalStatus) === "pending" ? (
                          <InlineStack gap="200" wrap={false}>
                            <ConfirmAction
                              trigger="secondary"
                              label="承認"
                              heading="返金手段変更を承認しますか"
                              message={`${item.sourceOrderName ?? "この登録"} の ${fmtYen(item.amount)}（${item.originalPaymentMethod ?? "—"} → ${item.actualRefundMethod ?? "—"}）を登録した日の精算・売上サマリーに入れます。Shopify には何もしません。`}
                              confirmLabel="承認する"
                              fields={{ intent: "approval", eventId: item.id, decision: "approve" }}
                            />
                            <ConfirmAction
                              label="却下"
                              heading="返金手段変更を却下しますか"
                              message={`${item.sourceOrderName ?? "この登録"} の ${fmtYen(item.amount)} は精算・売上サマリーに入りません。あとから承認には戻せません。Shopify の返金は取り消されません。`}
                              confirmLabel="却下する"
                              fields={{ intent: "approval", eventId: item.id, decision: "reject" }}
                            />
                          </InlineStack>
                        ) : null}
                      </BlockStack>
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
