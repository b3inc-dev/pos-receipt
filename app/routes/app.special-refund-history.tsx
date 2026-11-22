/**
 * /app/special-refund-history — 特殊返金・商品券調整 履歴
 * 要件書 §19.3: 管理画面 - 特殊返金履歴一覧・取引別確認
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useLocation, useNavigate, useNavigation, useSearchParams, useSubmit } from "react-router";
import { useState } from "react";
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
  Banner,
  Modal,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, SETTLEMENT_TABS } from "../components/TabGroupBar";
import { SuccessToast } from "../components/admin-ui";
import {
  getAppSetting,
  SPECIAL_REFUND_SETTINGS_KEY,
  DEFAULT_SPECIAL_REFUND_SETTINGS,
  type SpecialRefundSettings,
} from "../utils/appSettings.server";
import { decideSpecialRefundApproval } from "../services/specialRefundProcess.server";
import { approvalStatusLabel } from "../services/specialRefundApproval";

const PAGE_SIZE = 30;

const EVENT_TYPE_OPTIONS = [
  { label: "すべて", value: "" },
  { label: "現金返金", value: "cash_refund" },
  { label: "返金手段変更", value: "payment_method_override" },
  { label: "商品券調整", value: "voucher_change_adjustment" },
  { label: "レシート現金調整", value: "receipt_cash_adjustment" },
];

const APPROVAL_OPTIONS = [
  { label: "すべて", value: "" },
  { label: "承認待ち", value: "pending" },
  { label: "承認済み", value: "approved" },
  { label: "却下", value: "rejected" },
];

function approvalBadge(status: string) {
  const label = approvalStatusLabel(status);
  if (!label) return null;
  const tone = status === "pending" ? "attention" : status === "approved" ? "success" : "critical";
  return <Badge tone={tone}>{label}</Badge>;
}

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
  const approval  = url.searchParams.get("approval")  ?? "";
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

  const [total, items, pendingApprovalCount, srSettingsRaw] = await Promise.all([
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
        approvalDecidedAt: true,
        approvalDecidedBy: true,
        createdAt: true,
      },
    }),
    prisma.specialRefundEvent.count({
      where: { shopId: shop.id, status: "active", approvalStatus: "pending" },
    }),
    getAppSetting<Partial<SpecialRefundSettings>>(shop.id, SPECIAL_REFUND_SETTINGS_KEY),
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
      approvalDecidedAt: e.approvalDecidedAt?.toISOString() ?? null,
      approvalDecidedBy: e.approvalDecidedBy,
      createdAt: e.createdAt.toISOString(),
    })),
    pendingApprovalCount,
    approvalEnabled: srSettingsRaw?.requirePaymentOverrideApproval === true,
    approval,
    total,
    page,
    pageSize: PAGE_SIZE,
    dateFrom,
    dateTo,
    eventType,
  };
}

type ApprovalActionData =
  | { ok: true; message: string; warning: string | null; at: number }
  | { ok: false; error: string; at: number };

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const eventId = String(formData.get("eventId") ?? "");
  if ((intent !== "approve" && intent !== "reject") || !eventId) {
    return Response.json({ ok: false, error: "操作が分かりません。画面を読み直してください。", at: Date.now() }, { status: 400 });
  }
  const saved = await getAppSetting<Partial<SpecialRefundSettings>>(shop.id, SPECIAL_REFUND_SETTINGS_KEY);
  const settings: SpecialRefundSettings = { ...DEFAULT_SPECIAL_REFUND_SETTINGS, ...saved };
  const user = session.onlineAccessInfo?.associated_user;
  const decidedBy =
    [user?.last_name, user?.first_name].filter(Boolean).join(" ").trim() || "管理画面";

  const result = await decideSpecialRefundApproval(admin, shop.id, settings, {
    eventId,
    decision: intent,
    decidedBy,
  });
  if (!result.ok) {
    return Response.json({ ok: false, error: result.error, at: Date.now() }, { status: result.retryable ? 503 : 409 });
  }
  const message = result.approvalStatus === "approved" ? "承認しました" : "却下しました";
  let warning: string | null = null;
  if (result.approvalStatus === "approved" && result.shopifyRefundStatus === "failed") {
    warning = `承認しましたが、Shopify 返金に失敗しました。${result.shopifyRefundError ?? ""}`.trim();
  }
  if (result.settlementAlreadyExists) {
    const tail =
      "この登録の日の精算はもう作られています。数字を合わせるには、精算履歴からその日の精算を出し直してください。";
    warning = warning ? `${warning} ${tail}` : tail;
  }
  return Response.json({ ok: true, message, warning, at: Date.now() } satisfies ApprovalActionData);
}

export default function SpecialRefundHistoryPage() {
  const {
    items, total, page, pageSize, dateFrom, dateTo, eventType,
    approval, pendingApprovalCount, approvalEnabled,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<ApprovalActionData>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formMethod?.toLowerCase() === "post";
  const [confirm, setConfirm] = useState<{
    intent: "approve" | "reject";
    eventId: string;
    label: string;
  } | null>(null);
  const runDecision = () => {
    if (!confirm) return;
    const fd = new FormData();
    fd.set("intent", confirm.intent);
    fd.set("eventId", confirm.eventId);
    submit(fd, { method: "post" });
    setConfirm(null);
  };
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
          <SuccessToast message={actionData?.ok ? actionData.message : null} trigger={actionData?.at} />
          {/* お知らせ枠は 1 つ: 失敗 > 注意 > 承認待ちの件数 */}
          {actionData && !actionData.ok ? (
            <Layout.Section>
              <Banner tone="critical" title="承認・却下できませんでした">
                <p>{actionData.error}</p>
              </Banner>
            </Layout.Section>
          ) : actionData?.ok && actionData.warning ? (
            <Layout.Section>
              <Banner tone="warning" title={actionData.message}>
                <p>{actionData.warning}</p>
              </Banner>
            </Layout.Section>
          ) : pendingApprovalCount > 0 ? (
            <Layout.Section>
              <Banner
                tone="warning"
                title={`承認待ちの返金手段変更が ${pendingApprovalCount} 件あります`}
                action={approval === "pending" ? undefined : { content: "承認待ちだけ見る", onAction: () => handleFilter("approval", "pending") }}
              >
                <p>承認するまで Shopify 返金はせず、精算・売上サマリーにも入りません。</p>
              </Banner>
            </Layout.Section>
          ) : null}
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
                  {approvalEnabled || pendingApprovalCount > 0 || approval ? (
                    <Box minWidth="160px">
                      <Select
                        label="承認"
                        options={APPROVAL_OPTIONS}
                        value={approval}
                        onChange={(v) => handleFilter("approval", v)}
                      />
                    </Box>
                  ) : null}
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
                  { title: "承認" },
                  { title: "Shopify返金" },
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
                        {approvalBadge(item.approvalStatus) ?? <Text as="span" tone="subdued">—</Text>}
                        {item.approvalDecidedBy && item.approvalStatus !== "pending" ? (
                          <Text as="span" variant="bodySm" tone="subdued">{item.approvalDecidedBy}</Text>
                        ) : null}
                        {item.status === "active" &&
                        (item.approvalStatus === "pending" ||
                          (item.approvalStatus === "approved" && item.shopifyRefundStatus === "pending")) ? (
                          <InlineStack gap="200" wrap={false}>
                            <Button
                              size="slim"
                              variant="primary"
                              disabled={busy}
                              onClick={() =>
                                setConfirm({
                                  intent: "approve",
                                  eventId: item.id,
                                  label: `${item.sourceOrderName ?? item.sourceOrderId}・${fmtYen(item.amount)}`,
                                })
                              }
                            >
                              {item.approvalStatus === "approved" ? "もう一度実行" : "承認する"}
                            </Button>
                            {item.approvalStatus === "pending" ? (
                              <Button
                                size="slim"
                                tone="critical"
                                disabled={busy}
                                onClick={() =>
                                  setConfirm({
                                    intent: "reject",
                                    eventId: item.id,
                                    label: `${item.sourceOrderName ?? item.sourceOrderId}・${fmtYen(item.amount)}`,
                                  })
                                }
                              >
                                却下
                              </Button>
                            ) : null}
                          </InlineStack>
                        ) : null}
                      </BlockStack>
                    </IndexTable.Cell>
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
        <Modal
          open={confirm != null}
          onClose={() => setConfirm(null)}
          title={confirm?.intent === "reject" ? "返金手段変更を却下しますか" : "返金手段変更を承認しますか"}
          primaryAction={{
            content: confirm?.intent === "reject" ? "却下する" : "承認する",
            destructive: confirm?.intent === "reject",
            loading: busy,
            onAction: runDecision,
          }}
          secondaryActions={[{ content: "キャンセル", onAction: () => setConfirm(null) }]}
        >
          <Modal.Section>
            <BlockStack gap="200">
              <Text as="p" fontWeight="semibold">{confirm?.label}</Text>
              <Text as="p">
                {confirm?.intent === "reject"
                  ? "却下すると、この登録は精算・売上サマリーに入りません。Shopify 返金もしません。却下は取り消せません。"
                  : "承認すると、設定で Shopify 返金を実行する種別なら Shopify で返金し、登録した日の精算・売上サマリーに入れます。Shopify 返金は取り消せません。"}
              </Text>
            </BlockStack>
          </Modal.Section>
        </Modal>
      </Page>
    </PolarisPageWrapper>
  );
}
