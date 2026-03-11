/**
 * /app/payment-methods — 支払方法マスタ設定
 * 要件 §6, §13.3: 支払方法の表示名・分類・判定ルールを管理
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator, useLocation, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  IndexTable,
  useIndexResourceState,
  TextField,
  Select,
  Checkbox,
  Modal,
  Banner,
  Box,
  Badge,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

const CATEGORY_OPTIONS = [
  { label: "現金", value: "cash" },
  { label: "クレジットカード", value: "credit_card" },
  { label: "電子マネー", value: "e_money" },
  { label: "QR決済", value: "qr" },
  { label: "交通系IC", value: "transit_ic" },
  { label: "商品券", value: "voucher" },
  { label: "PayPal", value: "paypal" },
  { label: "その他", value: "uncategorized" },
];

const MATCH_TYPE_OPTIONS = [
  { label: "含む", value: "contains_match" },
  { label: "完全一致", value: "exact_match" },
  { label: "前方一致", value: "starts_with_match" },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const items = await prisma.paymentMethodMaster.findMany({
    where: { shopId: shop.id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  return { items };
}

type Item = Awaited<ReturnType<typeof loader>>["items"][number];

export default function PaymentMethodsPage() {
  const { items } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const to = (path: string) => () => navigate(path + q);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [form, setForm] = useState({
    rawGatewayPattern: "",
    formattedGatewayPattern: "",
    matchType: "contains_match" as string,
    displayLabel: "",
    category: "uncategorized",
    sortOrder: 0,
    isVoucher: false,
    voucherChangeSupported: false,
    voucherNoChangeSupported: false,
    selectableForSpecialRefund: true,
    selectableForReceiptCashAdjustment: false,
    selectableForPaymentOverride: false,
    enabled: true,
  });

  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(items.map((i) => i.id));

  const openCreate = useCallback(() => {
    setEditing(null);
    setForm({
      rawGatewayPattern: "",
      formattedGatewayPattern: "",
      matchType: "contains_match",
      displayLabel: "",
      category: "uncategorized",
      sortOrder: items.length,
      isVoucher: false,
      voucherChangeSupported: false,
      voucherNoChangeSupported: false,
      selectableForSpecialRefund: true,
      selectableForReceiptCashAdjustment: false,
      selectableForPaymentOverride: false,
      enabled: true,
    });
    setModalOpen(true);
  }, [items.length]);

  const openEdit = useCallback((item: Item) => {
    setEditing(item);
    setForm({
      rawGatewayPattern: item.rawGatewayPattern,
      formattedGatewayPattern: item.formattedGatewayPattern ?? "",
      matchType: item.matchType,
      displayLabel: item.displayLabel,
      category: item.category,
      sortOrder: item.sortOrder,
      isVoucher: item.isVoucher,
      voucherChangeSupported: item.voucherChangeSupported,
      voucherNoChangeSupported: item.voucherNoChangeSupported,
      selectableForSpecialRefund: item.selectableForSpecialRefund,
      selectableForReceiptCashAdjustment: item.selectableForReceiptCashAdjustment,
      selectableForPaymentOverride: item.selectableForPaymentOverride,
      enabled: item.enabled,
    });
    setModalOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setEditing(null);
  }, []);

  const handleSave = useCallback(async () => {
    const payload = {
      ...(editing ? { id: editing.id } : {}),
      rawGatewayPattern: form.rawGatewayPattern.trim(),
      formattedGatewayPattern: form.formattedGatewayPattern.trim() || null,
      matchType: form.matchType,
      displayLabel: form.displayLabel.trim(),
      category: form.category,
      sortOrder: form.sortOrder,
      isVoucher: form.isVoucher,
      voucherChangeSupported: form.voucherChangeSupported,
      voucherNoChangeSupported: form.voucherNoChangeSupported,
      selectableForSpecialRefund: form.selectableForSpecialRefund,
      selectableForReceiptCashAdjustment: form.selectableForReceiptCashAdjustment,
      selectableForPaymentOverride: form.selectableForPaymentOverride,
      enabled: form.enabled,
    };
    const url = editing
      ? `/api/settings/payment-methods/${editing.id}`
      : "/api/settings/payment-methods";
    const method = editing ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing ? { ...payload, id: undefined } : payload),
    });
    const data = await res.json();
    if (res.ok && data.item) {
      revalidator.revalidate();
      setModalOpen(false);
      setEditing(null);
    }
  }, [editing, form, revalidator]);

  const [saving, setSaving] = useState(false);
  const handleSaveWithLoading = useCallback(async () => {
    setSaving(true);
    try {
      await handleSave();
    } finally {
      setSaving(false);
    }
  }, [handleSave]);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm("この支払方法を削除しますか？")) return;
    const res = await fetch(`/api/settings/payment-methods/${id}`, { method: "DELETE" });
    if (res.ok) revalidator.revalidate();
  }, [revalidator]);

  const rowMarkup = items.map((item, index) => (
    <IndexTable.Row
      id={item.id}
      key={item.id}
      selected={selectedResources.includes(item.id)}
      position={index}
    >
      <IndexTable.Cell>
        <Text variant="bodyMd" fontWeight="semibold">{item.displayLabel}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{item.rawGatewayPattern}</IndexTable.Cell>
      <IndexTable.Cell>
        {CATEGORY_OPTIONS.find((o) => o.value === item.category)?.label ?? item.category}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={item.enabled ? "success" : "critical"}>
          {item.enabled ? "有効" : "無効"}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200">
          <Button size="slim" onClick={() => openEdit(item)}>編集</Button>
          <Button size="slim" tone="critical" onClick={() => handleDelete(item.id)}>
            削除
          </Button>
        </InlineStack>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <PolarisPageWrapper>
      <Page
        title="支払方法マスタ設定"
        backAction={{ content: "戻る", onAction: to("/app/settings") }}
        primaryAction={{ content: "追加", onAction: openCreate }}
      >
        <Layout>
          <Layout.Section>
            <Banner tone="info">
              精算レシートの支払方法表示名・特殊返金で選択可能な手段をここで設定します。Shopify の gateway 名に合わせてパターン（含む/完全一致/前方一致）を指定してください。
            </Banner>
          </Layout.Section>
          <Layout.Section>
            <Card>
              {items.length === 0 ? (
                <BlockStack gap="400">
                  <Text as="p" tone="subdued">
                    まだ支払方法が登録されていません。「追加」から gateway パターンと表示名を登録してください。
                  </Text>
                  <Button onClick={openCreate}>支払方法を追加</Button>
                </BlockStack>
              ) : (
                <IndexTable
                  resourceName={{ singular: "支払方法", plural: "支払方法" }}
                  itemCount={items.length}
                  selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                  onSelectionChange={handleSelectionChange}
                  headings={[
                    { title: "表示名" },
                    { title: "Gateway パターン" },
                    { title: "分類" },
                    { title: "状態" },
                    { title: "操作" },
                  ]}
                >
                  {rowMarkup}
                </IndexTable>
              )}
            </Card>
          </Layout.Section>
        </Layout>
      </Page>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? "支払方法を編集" : "支払方法を追加"}
        primaryAction={{
          content: "保存",
          onAction: handleSaveWithLoading,
          loading: saving,
          disabled: !form.rawGatewayPattern.trim() || !form.displayLabel.trim(),
        }}
        secondaryActions={[{ content: "キャンセル", onAction: closeModal }]}
        large
      >
        <Modal.Section>
          <BlockStack gap="400">
            <TextField
              label="Gateway パターン（必須）"
              value={form.rawGatewayPattern}
              onChange={(v) => setForm((p) => ({ ...p, rawGatewayPattern: v }))}
              helpText="Shopify の gateway 名に含まれる文字列。例: Cash, Credit, 現金"
              autoComplete="off"
            />
            <TextField
              label="Formatted gateway パターン（任意）"
              value={form.formattedGatewayPattern}
              onChange={(v) => setForm((p) => ({ ...p, formattedGatewayPattern: v }))}
              autoComplete="off"
            />
            <Select
              label="一致タイプ"
              options={MATCH_TYPE_OPTIONS}
              value={form.matchType}
              onChange={(v) => setForm((p) => ({ ...p, matchType: v }))}
            />
            <TextField
              label="表示名（必須）"
              value={form.displayLabel}
              onChange={(v) => setForm((p) => ({ ...p, displayLabel: v }))}
              helpText="精算・特殊返金で表示する名前"
              autoComplete="off"
            />
            <Select
              label="分類"
              options={CATEGORY_OPTIONS}
              value={form.category}
              onChange={(v) => setForm((p) => ({ ...p, category: v }))}
            />
            <TextField
              label="並び順"
              type="number"
              value={String(form.sortOrder)}
              onChange={(v) => setForm((p) => ({ ...p, sortOrder: parseInt(v, 10) || 0 }))}
              autoComplete="off"
            />
            <Box paddingBlockStart="200">
              <Text variant="headingSm" as="h3">商品券・特殊返金</Text>
            </Box>
            <Checkbox
              label="商品券として扱う"
              checked={form.isVoucher}
              onChange={(v) => setForm((p) => ({ ...p, isVoucher: v }))}
            />
            <Checkbox
              label="釣銭あり対応"
              checked={form.voucherChangeSupported}
              onChange={(v) => setForm((p) => ({ ...p, voucherChangeSupported: v }))}
            />
            <Checkbox
              label="釣銭なし対応"
              checked={form.voucherNoChangeSupported}
              onChange={(v) => setForm((p) => ({ ...p, voucherNoChangeSupported: v }))}
            />
            <Checkbox
              label="特殊返金で選択可能"
              checked={form.selectableForSpecialRefund}
              onChange={(v) => setForm((p) => ({ ...p, selectableForSpecialRefund: v }))}
            />
            <Checkbox
              label="領収書キャッシュ調整で選択可能"
              checked={form.selectableForReceiptCashAdjustment}
              onChange={(v) => setForm((p) => ({ ...p, selectableForReceiptCashAdjustment: v }))}
            />
            <Checkbox
              label="返金手段変更で選択可能"
              checked={form.selectableForPaymentOverride}
              onChange={(v) => setForm((p) => ({ ...p, selectableForPaymentOverride: v }))}
            />
            <Checkbox
              label="有効"
              checked={form.enabled}
              onChange={(v) => setForm((p) => ({ ...p, enabled: v }))}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </PolarisPageWrapper>
  );
}
