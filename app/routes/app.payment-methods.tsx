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
  TextField,
  Select,
  Checkbox,
  Modal,
  Box,
  Badge,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, STORE_TABS } from "../components/TabGroupBar";
import { AdminIntro, DeleteIconButton, SuccessToast } from "../components/admin-ui";
import { syncPaymentMethodsFromRecentOrders } from "../services/paymentMethodSync.server";

const CATEGORY_OPTIONS = [
  { label: "現金", value: "cash" },
  { label: "クレジットカード", value: "credit_card" },
  { label: "電子マネー", value: "e_money" },
  { label: "QR決済", value: "qr" },
  { label: "交通系IC", value: "transit_ic" },
  { label: "商品券・ギフトカード", value: "voucher" },
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

  let syncResult: { created: number; gatewaysFound: number } | null = null;
  try {
    const r = await syncPaymentMethodsFromRecentOrders(admin, shop.id, 90);
    syncResult = { created: r.created, gatewaysFound: r.gatewaysFound };
  } catch {
    syncResult = null;
  }

  const items = await prisma.paymentMethodMaster.findMany({
    where: { shopId: shop.id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  return { items, syncResult };
}

type Item = Awaited<ReturnType<typeof loader>>["items"][number];

export default function PaymentMethodsPage() {
  const { items, syncResult } = useLoaderData<typeof loader>();
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

  // 削除はゴミ箱のボタン → 確認の窓（ブラウザの確認の窓でなく画面の窓。UI ルール v1.1 4章）。送る中身は今までと同じ
  const [deleting, setDeleting] = useState<Item | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const handleDelete = useCallback(async (id: string) => {
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/settings/payment-methods/${id}`, { method: "DELETE" });
      if (res.ok) revalidator.revalidate();
    } finally {
      setDeleteBusy(false);
      setDeleting(null);
    }
  }, [revalidator]);

  const rowMarkup = items.map((item) => (
    <tr key={item.id}>
      <td data-label="表示名" className="History-text">
        <Text as="span" variant="bodyMd" fontWeight="semibold">{item.displayLabel}</Text>
        {/* Shopify 側の名前（cash・shopify_payments など）は英字のまま主役にせず、小さく添えるだけ（全画面点検 11/23） */}
        <span className="History-memo">Shopify での名前: {item.rawGatewayPattern}</span>
      </td>
      <td data-label="分類" className="History-keep">
        {CATEGORY_OPTIONS.find((o) => o.value === item.category)?.label ?? item.category}
      </td>
      <td data-label="商品券" className="History-keep">
        <Badge tone={item.isVoucher ? "attention" : undefined}>
          {item.isVoucher ? "○" : "－"}
        </Badge>
      </td>
      <td data-label="釣銭あり" className="History-keep">
        <Badge tone={item.voucherChangeSupported ? "success" : undefined}>
          {item.voucherChangeSupported ? "○" : "－"}
        </Badge>
      </td>
      <td data-label="状態" className="History-keep">
        {/* 色は意味で決める: 緑＝有効、灰＝停止（UI ルール v1.1 1章） */}
        <Badge tone={item.enabled ? "success" : undefined}>
          {item.enabled ? "有効" : "無効"}
        </Badge>
      </td>
      <td data-label="操作" className="History-keep">
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Button size="slim" onClick={() => openEdit(item)}>編集</Button>
          <DeleteIconButton label={`${item.displayLabel}を削除`} onClick={() => setDeleting(item)} />
        </InlineStack>
      </td>
    </tr>
  ));

  return (
    <PolarisPageWrapper>
      <Page
        title="支払方法マスタ設定"
        backAction={{ content: "ホーム", onAction: to("/app") }}
        primaryAction={{ content: "追加", onAction: openCreate }}
      >
        <Card padding="0">
          <TabGroupBar tabs={STORE_TABS} />
        </Card>
        <Layout>
          <Layout.Section>
            {/* 画面全体の説明は AdminIntro（1〜2文）。自動登録の知らせはトースト（UI ルール v1.1 5章・7章） */}
            <AdminIntro>
              <p>精算レシートの支払方法表示名・特殊返金で選択可能な手段をここで設定します。直近90日のPOS取引から決済名は自動登録されます。必要に応じて表示名・商品券フラグを手直ししてください。</p>
            </AdminIntro>
            <SuccessToast
              message={syncResult && syncResult.created > 0
                ? `直近90日の取引から ${syncResult.created} 件の決済方法を自動登録しました（検出 ${syncResult.gatewaysFound} 種類）`
                : null}
              trigger={syncResult}
            />
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
                // スマホでは横スクロールさせず 1 件 1 枚のカードにする（data-label が各行の見出し。UI ルール v1.1 8章）
                <div className="History-scroll">
                  <table className="History-table">
                    <thead>
                      <tr>
                        <th scope="col">表示名</th>
                        <th scope="col">分類</th>
                        <th scope="col">商品券</th>
                        <th scope="col">釣銭あり</th>
                        <th scope="col">状態</th>
                        <th scope="col">操作</th>
                      </tr>
                    </thead>
                    <tbody>{rowMarkup}</tbody>
                  </table>
                </div>
              )}
            </Card>
          </Layout.Section>
        </Layout>
      </Page>

      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="支払方法を削除しますか？"
        primaryAction={{
          content: "削除",
          destructive: true,
          loading: deleteBusy,
          onAction: () => { if (deleting) void handleDelete(deleting.id); },
        }}
        secondaryActions={[{ content: "キャンセル", onAction: () => setDeleting(null) }]}
      >
        <Modal.Section>
          <Text as="p">「{deleting?.displayLabel}」を削除します。元に戻せません。</Text>
        </Modal.Section>
      </Modal>

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
              label="Shopify での支払方法の名前（必須）"
              value={form.rawGatewayPattern}
              onChange={(v) => setForm((p) => ({ ...p, rawGatewayPattern: v }))}
              helpText="Shopify の取引に記録される支払方法の名前（またはその一部）。例: 現金、cash"
              autoComplete="off"
            />
            <TextField
              label="Shopify の画面に出る支払方法の名前（任意）"
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
            <Text as="p" variant="bodySm" tone="subdued">
              Shopify の gateway に「gift_card」「Gift card」等が含まれる場合、上記パターンで登録しONにしてください。精算・特殊返金で商品券として扱われます。
            </Text>
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
