/**
 * /app/order-adjustments?orderId=… — 1 件の注文の特殊返金・商品券調整（③④）を見て、「変更」「無効化」「書き直す」
 * 特殊返金履歴の行の「変更」と、Shopify の注文ページのブロック（order-adjustments-block）の「変更」から開く。
 * 記録は注文メタフィールド pos.adjustments（docs/ORDER_ADJUSTMENTS_METAFIELD.md）。直すと前の行は無効にして残す。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useLocation, useNavigate, useNavigation } from "react-router";
import { useState } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  BlockStack,
  InlineStack,
  Box,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { ConfirmAction, StatusBanner, SuccessToast } from "../components/admin-ui";
import { editAdjustmentEvent, voidAdjustmentEvent } from "../services/orderAdjustmentEdit.server";
import {
  buildOrderAdjustmentsDocForOrder,
  fetchOrderAdjustmentDocs,
  isOrderAdjustmentsMetafieldEnabled,
  syncOrderAdjustmentsMetafield,
} from "../services/orderAdjustments.server";
import { countDateOf, orderMetafieldStateOf, toOrderGid, type OrderMetafieldState } from "../services/orderAdjustmentsPure.server";
import { parseAdjustmentEditBody } from "../utils/orderAdjustmentEditInput";
import { normalizeApprovalStatus } from "../utils/specialRefundApproval";

const EVENT_TYPE_LABELS: Record<string, string> = {
  cash_refund: "現金返金",
  payment_method_override: "返金手段の付け替え",
  voucher_change_adjustment: "商品券",
  receipt_cash_adjustment: "レシートの現金を直す",
};

function fmtYen(v: string | number | null | undefined) {
  if (v == null || v === "") return "—";
  return `¥${Math.round(Number(v)).toLocaleString("ja-JP")}`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const url = new URL(request.url);
  const orderIdRaw = (url.searchParams.get("orderId") ?? "").trim();
  if (!orderIdRaw) {
    return { ok: false as const, message: "注文が指定されていません。特殊返金履歴から開いてください。" };
  }
  const orderGid = toOrderGid(orderIdRaw);
  const digits = orderGid.replace(/\D/g, "");
  const metafieldEnabled = await isOrderAdjustmentsMetafieldEnabled(shop.id);
  const [rows, selectable, built, current] = await Promise.all([
    prisma.specialRefundEvent.findMany({
      where: { shopId: shop.id, sourceOrderId: { in: [orderGid, digits, orderIdRaw] } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.paymentMethodMaster.findMany({
      where: { shopId: shop.id, enabled: true, selectableForSpecialRefund: true },
      orderBy: { sortOrder: "asc" },
      select: { rawGatewayPattern: true, displayLabel: true },
    }),
    buildOrderAdjustmentsDocForOrder(admin, shop.id, orderGid),
    metafieldEnabled
      ? fetchOrderAdjustmentDocs(admin, [orderGid])
      : Promise.resolve({ fetched: false, docs: new Map<string, string | null>() }),
  ]);
  const currentValue = current.docs.get(orderGid) ?? null;
  // 注文に書かない設定のときは比べない（"off"）
  const metafieldState: OrderMetafieldState | "off" = metafieldEnabled
    ? orderMetafieldStateOf({
        rowCount: rows.length,
        fetched: current.fetched,
        currentValue,
        built: built.doc,
      })
    : "off";
  const labelOf = new Map(selectable.map((m) => [m.rawGatewayPattern.toLowerCase(), m.displayLabel]));
  const methodLabel = (m: string | null) => (m ? (labelOf.get(m.toLowerCase()) ?? m) : null);
  return {
    ok: true as const,
    orderGid,
    orderName: rows.find((r) => r.sourceOrderName)?.sourceOrderName ?? `#${digits}`,
    summary: built.summary,
    metafieldState,
    refundMethods: selectable.map((m) => ({ value: m.rawGatewayPattern, label: m.displayLabel })),
    items: rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      amount: r.amount.toString(),
      originalPaymentMethod: r.originalPaymentMethod,
      actualRefundMethod: r.actualRefundMethod,
      fromLabel: methodLabel(r.originalPaymentMethod),
      toLabel: methodLabel(r.actualRefundMethod),
      adjustKind: r.adjustKind,
      voucherFaceValue: r.voucherFaceValue?.toString() ?? null,
      voucherAppliedAmount: r.voucherAppliedAmount?.toString() ?? null,
      voucherChangeAmount: r.voucherChangeAmount?.toString() ?? null,
      status: r.status,
      approvalStatus: r.approvalStatus,
      shopifyRefundStatus: r.shopifyRefundStatus,
      countDate: countDateOf(r, built.timeZone),
      replacesEventId: r.replacesEventId,
      voidReason: r.voidReason,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const eventId = String(form.get("eventId") ?? "");
  const by = session.onlineAccessInfo?.associated_user
    ? [session.onlineAccessInfo.associated_user.last_name, session.onlineAccessInfo.associated_user.first_name]
        .filter(Boolean)
        .join(" ") || "管理画面"
    : "管理画面";

  if (intent === "resync") {
    const orderId = String(form.get("orderId") ?? "");
    const r = await syncOrderAdjustmentsMetafield(admin, shop.id, orderId);
    if (r.ok && r.skipped) {
      return { ok: false as const, message: "注文への記録はオフです。特殊返金設定の「注文への記録」をオンにすると書けます。" };
    }
    return r.ok
      ? { ok: true as const, message: "注文の記録を書き直しました", at: Date.now() }
      : { ok: false as const, message: `注文の記録を書けませんでした（${r.error}）。しばらくしてからもう一度押してください。` };
  }
  if (!eventId) return { ok: false as const, message: "登録が見つかりません。画面を読み直してください。" };

  if (intent === "void") {
    const r = await voidAdjustmentEvent(admin, shop.id, eventId, {
      reason: String(form.get("reason") ?? "") || "管理画面で無効化",
      by,
    });
    if (!r.ok) return { ok: false as const, message: r.message };
    return {
      ok: true as const,
      message: "無効にしました",
      warning: r.warning,
      settlementAlreadyConfirmed: r.settlementAlreadyConfirmed,
      confirmedDates: r.confirmedDates,
      metafieldWritten: r.metafieldWritten,
      at: Date.now(),
    };
  }
  if (intent === "edit") {
    const body: Record<string, unknown> = {};
    for (const k of ["amount", "actualRefundMethod", "adjustKind", "voucherFaceValue", "dateMode", "reason"]) {
      const v = form.get(k);
      if (v != null) body[k] = String(v);
    }
    body.by = by;
    const r = await editAdjustmentEvent(admin, shop.id, eventId, parseAdjustmentEditBody(body));
    if (!r.ok) return { ok: false as const, message: r.message, eventId };
    return {
      ok: true as const,
      message: "変更しました",
      warning: r.warning,
      settlementAlreadyConfirmed: r.settlementAlreadyConfirmed,
      confirmedDates: r.confirmedDates,
      metafieldWritten: r.metafieldWritten,
      at: Date.now(),
    };
  }
  return { ok: false as const, message: "この操作は受け付けていません。画面を読み直してください。" };
}

type LoaderOk = Extract<Awaited<ReturnType<typeof loader>>, { ok: true }>;
type Item = LoaderOk["items"][number];

function statusBadge(item: Item) {
  if (item.status === "voided") return <Badge>無効</Badge>;
  const a = normalizeApprovalStatus(item.approvalStatus);
  if (a === "pending") return <Badge tone="attention">承認待ち</Badge>;
  if (a === "rejected") return <Badge>却下</Badge>;
  return <Badge tone="success">有効</Badge>;
}

function EditPanel({ item, refundMethods, busy, onCancel }: {
  item: Item;
  refundMethods: { value: string; label: string }[];
  busy: boolean;
  onCancel: () => void;
}) {
  const isVoucher = item.eventType === "voucher_change_adjustment";
  const needsMethod = item.eventType === "cash_refund" || item.eventType === "payment_method_override";
  return (
    <Box paddingBlockStart="300">
      <Form method="post">
        <input type="hidden" name="intent" value="edit" />
        <input type="hidden" name="eventId" value={item.id} />
        <BlockStack gap="300">
          {isVoucher ? (
            <s-number-field
              label="受け取った商品券の額面"
              name="voucherFaceValue"
              defaultValue={String(Math.round(Number(item.voucherFaceValue ?? 0)))}
              suffix="円"
              min={1}
              details={`商品券で払った額 ${fmtYen(item.voucherAppliedAmount)}（注文から）。お釣りは額面との差で出し直します。`}
            />
          ) : (
            <s-number-field
              label="金額"
              name="amount"
              defaultValue={String(Math.round(Number(item.amount)))}
              suffix="円"
              min={1}
            />
          )}
          {needsMethod ? (
            <s-select label="実際の返金手段" name="actualRefundMethod" value={item.actualRefundMethod ?? ""}>
              {refundMethods.map((m) => (
                <s-option key={m.value} value={m.value}>{m.label}</s-option>
              ))}
            </s-select>
          ) : null}
          {item.eventType === "receipt_cash_adjustment" ? (
            <s-choice-list label="調整の種類" name="adjustKind" values={[item.adjustKind ?? "undo"]}>
              <s-choice value="undo">返金を取り消す（売上に戻す）</s-choice>
              <s-choice value="extra">現金を足す（売上に足す）</s-choice>
            </s-choice-list>
          ) : null}
          {/* 商品券は注文の日で数えるので、数える日は選ばない */}
          {isVoucher ? null : (
            <s-choice-list label="数える日" name="dateMode" values={["original"]}>
              <s-choice value="original">元の日のまま（{item.countDate}）</s-choice>
              <s-choice value="today">今日の分にする</s-choice>
            </s-choice-list>
          )}
          <s-text-field label="直したわけ" name="reason" required placeholder="例: 返金手段の選び間違い" />
          {item.shopifyRefundStatus === "success" ? (
            <Text as="p" variant="bodySm" tone="caution">
              この登録は Shopify でも返金済みです。Shopify の返金は直りません（アプリの記録だけを直します）。
            </Text>
          ) : null}
          <InlineStack gap="200">
            <s-button type="submit" variant="primary" loading={busy || undefined}>変更する</s-button>
            <s-button variant="tertiary" onClick={onCancel}>やめる</s-button>
          </InlineStack>
        </BlockStack>
      </Form>
    </Box>
  );
}

export default function OrderAdjustmentsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const [editingId, setEditingId] = useState<string | null>(null);
  const busy = navigation.state !== "idle";
  const back = () => navigate("/app/special-refund-history" + (location.search.includes("host=") ? location.search.replace(/orderId=[^&]*&?/, "") : ""));

  if (!data.ok) {
    return (
      <PolarisPageWrapper>
        <Page title="特殊返金・商品券調整" backAction={{ content: "特殊返金履歴", onAction: back }}>
          <StatusBanner tone="critical" heading="注文を開けませんでした">{data.message}</StatusBanner>
        </Page>
      </PolarisPageWrapper>
    );
  }

  // お知らせ枠は 1 つだけ（失敗 → 注意 → 案内の順）
  let notice: { tone: "critical" | "warning" | "info"; heading: string; text: string } | null = null;
  if (actionData && !actionData.ok) {
    notice = { tone: "critical", heading: "できませんでした", text: actionData.message };
  } else if (actionData?.ok && "settlementAlreadyConfirmed" in actionData && actionData.settlementAlreadyConfirmed) {
    const days = ("confirmedDates" in actionData ? actionData.confirmedDates ?? [] : []).join("・");
    notice = {
      tone: "warning",
      heading: `${days ? `${days} の` : "この日の"}精算はもう確定しています`,
      text: "POS の精算でその日を開き「更新」を押し、「今の数で再確定する」を押してください。" + (actionData.warning ? ` ${actionData.warning}` : ""),
    };
  } else if (actionData?.ok && "warning" in actionData && actionData.warning) {
    notice = { tone: "warning", heading: "返金はそのままです", text: actionData.warning };
  } else if (data.metafieldState === "differs") {
    notice = {
      tone: "warning",
      heading: "注文の記録がアプリの記録と違います",
      text: "Shopify の画面で書き換えられたか、書き込みが途中で失敗した可能性があります。精算はアプリの記録で数えます。「書き直す」を押すと、注文の記録をアプリの記録に戻します。",
    };
  } else if (data.metafieldState === "missing") {
    notice = {
      tone: "warning",
      heading: "注文にまだ書けていません",
      text: "精算はアプリの記録で数えますが、注文を読むほかのアプリからは見えません。「書き直す」を押してください。",
    };
  } else if (data.metafieldState === "invalid") {
    notice = {
      tone: "warning",
      heading: "注文の記録の形が読めません",
      text: "Shopify の画面で書き換えられた可能性があります。精算はアプリの記録で数えます。「書き直す」を押すと、アプリの記録で書き直します。",
    };
  } else if (data.metafieldState === "unreadable") {
    notice = { tone: "info", heading: "注文の記録を読めませんでした", text: "しばらくしてから開き直してください。" };
  }

  const active = data.items.filter((i) => i.status !== "voided");
  const voided = data.items.filter((i) => i.status === "voided");

  return (
    <PolarisPageWrapper>
      <Page
        title={`${data.orderName} の特殊返金・商品券調整`}
        backAction={{ content: "特殊返金履歴", onAction: back }}
      >
        <SuccessToast message={actionData?.ok ? actionData.message : null} trigger={actionData} />
        <Layout>
          {notice ? (
            <Layout.Section>
              <StatusBanner tone={notice.tone} heading={notice.heading}>{notice.text}</StatusBanner>
            </Layout.Section>
          ) : null}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h2" variant="headingSm">注文の記録</Text>
                  {data.metafieldState === "off" ? (
                    <Badge>注文への記録はオフ</Badge>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="resync" />
                      <input type="hidden" name="orderId" value={data.orderGid} />
                      <s-button type="submit" variant="secondary" loading={busy || undefined}>書き直す</s-button>
                    </Form>
                  )}
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  {data.summary || "有効な登録はありません"}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingSm">登録</Text>
                {active.length === 0 ? (
                  <Text as="p" tone="subdued">有効な登録はありません。</Text>
                ) : (
                  active.map((item, idx) => (
                    <BlockStack key={item.id} gap="200">
                      {idx > 0 ? <Divider /> : null}
                      <InlineStack align="space-between" blockAlign="start" wrap>
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" fontWeight="semibold">{EVENT_TYPE_LABELS[item.eventType] ?? item.eventType}</Text>
                            {statusBadge(item)}
                            {item.shopifyRefundStatus === "success" ? <Badge tone="info">返金済</Badge> : null}
                          </InlineStack>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {item.eventType === "voucher_change_adjustment"
                              ? `額面 ${fmtYen(item.voucherFaceValue)}・払った額 ${fmtYen(item.voucherAppliedAmount)}・お釣り ${fmtYen(item.voucherChangeAmount)}`
                              : `${item.fromLabel ? `${item.fromLabel} → ` : ""}${item.toLabel ?? "—"}`}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {item.countDate} の分{item.createdBy ? `・${item.createdBy}` : ""}{item.replacesEventId ? "・変更あり" : ""}
                          </Text>
                        </BlockStack>
                        <InlineStack gap="200" blockAlign="center" wrap={false}>
                          <Text as="span" numeric>{fmtYen(item.amount)}</Text>
                          {item.status === "active" && item.shopifyRefundStatus !== "pending" ? (
                            <s-button variant="secondary" onClick={() => setEditingId(editingId === item.id ? null : item.id)}>
                              変更
                            </s-button>
                          ) : null}
                          {item.status === "active" ? (
                            <ConfirmAction
                              label="無効化"
                              heading="この登録を無効にしますか"
                              message={`${data.orderName} の ${fmtYen(item.amount)} を精算から外します。${item.shopifyRefundStatus === "success" ? "Shopify の返金は取り消されません。" : ""}直すだけなら「変更」を使ってください。`}
                              confirmLabel="無効にする"
                              fields={{ intent: "void", eventId: item.id }}
                            />
                          ) : null}
                        </InlineStack>
                      </InlineStack>
                      {item.shopifyRefundStatus === "pending" ? (
                        <Text as="p" variant="bodySm" tone="caution">
                          返金処理中（結果待ち）です。POS の特殊返金で「返金を確かめる」を押してから直してください。
                        </Text>
                      ) : null}
                      {editingId === item.id ? (
                        <EditPanel item={item} refundMethods={data.refundMethods} busy={busy} onCancel={() => setEditingId(null)} />
                      ) : null}
                    </BlockStack>
                  ))
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
          {voided.length > 0 ? (
            <Layout.Section>
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingSm">無効にした登録（{voided.length} 件）</Text>
                  {voided.map((item) => (
                    <InlineStack key={item.id} align="space-between" wrap>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {EVENT_TYPE_LABELS[item.eventType] ?? item.eventType}・{item.countDate} の分{item.voidReason ? `・わけ: ${item.voidReason}` : ""}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued" numeric>{fmtYen(item.amount)}</Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              </Card>
            </Layout.Section>
          ) : null}
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
