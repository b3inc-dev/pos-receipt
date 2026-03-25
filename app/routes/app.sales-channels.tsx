/**
 * /app/sales-channels — チャネル管理（仮想ロケーション）
 * Shopify の source_name ベースでチャネルを設定し、売上サマリーに表示する
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSubmit, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  TextField,
  Checkbox,
  Button,
  BlockStack,
  Banner,
  Box,
  InlineStack,
  Divider,
  Badge,
  EmptyState,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import prisma from "../db.server";
import { autoDiscoverChannels } from "../services/salesChannelEngine.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, SETTINGS_TABS } from "../components/TabGroupBar";

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const channels = await prisma.salesChannel.findMany({
    where: { shopId: shop.id },
    orderBy: { sortOrder: "asc" },
  });

  return {
    channels: channels.map((c) => ({
      id: c.id,
      name: c.name,
      displayName: c.displayName ?? "",
      shortName: c.shortName ?? "",
      sortOrder: c.sortOrder,
      salesSummaryEnabled: c.salesSummaryEnabled,
      includeInOverallTotals: c.includeInOverallTotals,
      sourceNamesJson: c.sourceNamesJson,
    })),
  };
}

// ── Action ────────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "upsert") {
    const id = formData.get("id") as string | null;
    const name = (formData.get("name") as string ?? "").trim();
    const displayName = (formData.get("displayName") as string ?? "").trim() || null;
    const shortName = (formData.get("shortName") as string ?? "").trim() || null;
    const sortOrder = parseInt(formData.get("sortOrder") as string ?? "0", 10) || 0;
    const salesSummaryEnabled = formData.get("salesSummaryEnabled") === "true";
    const includeInOverallTotals = formData.get("includeInOverallTotals") === "true";
    const sourceNamesRaw = (formData.get("sourceNamesJson") as string ?? "[]").trim();

    // sourceNamesJson の正規化（ソートして比較可能にする）
    let sourceNames: string[] = [];
    try {
      sourceNames = (JSON.parse(sourceNamesRaw) as unknown[])
        .map((v) => String(v).trim())
        .filter(Boolean);
    } catch {
      return Response.json({ ok: false, error: "sourceNamesJson のフォーマットが不正です" }, { status: 400 });
    }
    const sourceNamesJson = JSON.stringify([...sourceNames].sort());

    if (!name) {
      return Response.json({ ok: false, error: "チャネル名は必須です" }, { status: 400 });
    }

    if (id) {
      const existing = await prisma.salesChannel.findFirst({ where: { id, shopId: shop.id } });
      if (!existing) return Response.json({ ok: false, error: "Not found" }, { status: 404 });

      // source_name マッピングが変更された場合はスナップショットをリセット（キャッシュ再計算トリガー）
      const snapshotReset = existing.sourceNamesJson !== sourceNamesJson;

      await prisma.salesChannel.update({
        where: { id },
        data: {
          name,
          displayName,
          shortName,
          sortOrder,
          salesSummaryEnabled,
          includeInOverallTotals,
          sourceNamesJson,
          ...(snapshotReset ? { sourceNamesSnapshot: "" } : {}),
        },
      });
    } else {
      await prisma.salesChannel.create({
        data: {
          shopId: shop.id,
          name,
          displayName,
          shortName,
          sortOrder,
          salesSummaryEnabled,
          includeInOverallTotals,
          sourceNamesJson,
          sourceNamesSnapshot: "",
        },
      });
    }
    return Response.json({ ok: true });
  }

  if (intent === "auto-discover") {
    const result = await autoDiscoverChannels(admin, shop.id, { forceScan: true });
    return Response.json({ ok: true, discovered: result.discovered });
  }

  if (intent === "delete") {
    const id = formData.get("id") as string;
    const existing = await prisma.salesChannel.findFirst({ where: { id, shopId: shop.id } });
    if (!existing) return Response.json({ ok: false, error: "Not found" }, { status: 404 });
    await prisma.salesChannel.delete({ where: { id } });
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { status: 400 });
}

// ── Component ──────────────────────────────────────────────────────────────────

type ChannelRow = {
  id: string;
  name: string;
  displayName: string;
  shortName: string;
  sortOrder: number;
  salesSummaryEnabled: boolean;
  includeInOverallTotals: boolean;
  sourceNamesJson: string;
};

const EMPTY_CHANNEL: Omit<ChannelRow, "id"> = {
  name: "",
  displayName: "",
  shortName: "",
  sortOrder: 0,
  salesSummaryEnabled: true,
  includeInOverallTotals: true,
  sourceNamesJson: "[]",
};

function parseSourceNames(json: string): string {
  try {
    const arr = JSON.parse(json) as string[];
    return arr.join(", ");
  } catch {
    return "";
  }
}

function serializeSourceNames(input: string): string {
  const names = input
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return JSON.stringify([...new Set(names)].sort());
}

function ChannelForm({
  channel,
  onSave,
  onCancel,
  onDelete,
  isSaving,
}: {
  channel: ChannelRow | Omit<ChannelRow, "id">;
  onSave: (data: Omit<ChannelRow, "id"> & { id?: string }) => void;
  onCancel: () => void;
  onDelete?: () => void;
  isSaving: boolean;
}) {
  const [form, setForm] = useState({
    name: channel.name,
    displayName: channel.displayName,
    shortName: channel.shortName,
    sortOrder: String(channel.sortOrder),
    salesSummaryEnabled: channel.salesSummaryEnabled,
    includeInOverallTotals: channel.includeInOverallTotals,
    sourceNamesInput: parseSourceNames(channel.sourceNamesJson),
  });

  const set = (key: string, val: string | boolean) =>
    setForm((prev) => ({ ...prev, [key]: val }));

  const handleSave = useCallback(() => {
    onSave({
      ...("id" in channel ? { id: channel.id } : {}),
      name: form.name,
      displayName: form.displayName,
      shortName: form.shortName,
      sortOrder: parseInt(form.sortOrder, 10) || 0,
      salesSummaryEnabled: form.salesSummaryEnabled,
      includeInOverallTotals: form.includeInOverallTotals,
      sourceNamesJson: serializeSourceNames(form.sourceNamesInput),
    });
  }, [form, channel, onSave]);

  return (
    <BlockStack gap="400">
      <InlineStack gap="400" align="start" blockAlign="start">
        <Box minWidth="200px">
          <TextField
            label="チャネル名（管理用）"
            value={form.name}
            onChange={(v) => set("name", v)}
            autoComplete="off"
          />
        </Box>
        <Box minWidth="200px">
          <TextField
            label="表示名"
            value={form.displayName}
            onChange={(v) => set("displayName", v)}
            placeholder="未入力時はチャネル名を使用"
            autoComplete="off"
          />
        </Box>
        <Box minWidth="100px">
          <TextField
            label="短縮名"
            value={form.shortName}
            onChange={(v) => set("shortName", v)}
            autoComplete="off"
          />
        </Box>
        <Box minWidth="80px">
          <TextField
            label="並び順"
            value={form.sortOrder}
            onChange={(v) => set("sortOrder", v)}
            type="number"
            autoComplete="off"
          />
        </Box>
      </InlineStack>

      <TextField
        label="source_name（カンマ区切り・複数可）"
        value={form.sourceNamesInput}
        onChange={(v) => set("sourceNamesInput", v)}
        placeholder="例: web  /  amazon, amazon_marketplace  /  tiktok"
        helpText="Shopify 注文の source_name フィールドの値を入力してください。デバッグAPI (/api/debug/channel-sources) で確認できます。"
        multiline={2}
        autoComplete="off"
      />

      <InlineStack gap="400">
        <Checkbox
          label="売上サマリーで集計する"
          checked={form.salesSummaryEnabled}
          onChange={(v) => set("salesSummaryEnabled", v)}
        />
        <Checkbox
          label="全体合計に含める"
          checked={form.includeInOverallTotals}
          onChange={(v) => set("includeInOverallTotals", v)}
        />
      </InlineStack>

      <InlineStack gap="300">
        <Button variant="primary" onClick={handleSave} loading={isSaving}>
          保存
        </Button>
        <Button onClick={onCancel}>キャンセル</Button>
        {onDelete && (
          <Button tone="critical" onClick={onDelete}>
            削除
          </Button>
        )}
      </InlineStack>
    </BlockStack>
  );
}

export default function SalesChannelsPage() {
  const { channels: initial } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigate = useNavigate();

  const [channels, setChannels] = useState<ChannelRow[]>(initial);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedBanner, setSavedBanner] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);

  const handleSave = useCallback(
    (data: Omit<ChannelRow, "id"> & { id?: string }) => {
      setIsSaving(true);
      const formData = new FormData();
      formData.set("intent", "upsert");
      if (data.id) formData.set("id", data.id);
      formData.set("name", data.name);
      formData.set("displayName", data.displayName);
      formData.set("shortName", data.shortName);
      formData.set("sortOrder", String(data.sortOrder));
      formData.set("salesSummaryEnabled", String(data.salesSummaryEnabled));
      formData.set("includeInOverallTotals", String(data.includeInOverallTotals));
      formData.set("sourceNamesJson", data.sourceNamesJson);

      submit(formData, { method: "POST", replace: true });

      // 楽観的更新
      setChannels((prev) => {
        if (data.id) {
          return prev.map((c) => (c.id === data.id ? { ...c, ...data, id: c.id } : c));
        }
        // 新規は暫定 ID で追加（ページリロードで正式 ID になる）
        return [...prev, { ...data, id: `temp-${Date.now()}` }];
      });
      setEditingId(null);
      setAddingNew(false);
      setIsSaving(false);
      setSavedBanner(true);
      setTimeout(() => setSavedBanner(false), 3000);
    },
    [submit]
  );

  const handleAutoDiscover = useCallback(async () => {
    setIsScanning(true);
    setScanResult(null);
    const formData = new FormData();
    formData.set("intent", "auto-discover");
    const res = await fetch(window.location.pathname, { method: "POST", body: formData });
    const json = await res.json() as { ok: boolean; discovered?: string[] };
    setIsScanning(false);
    if (json.ok) {
      const count = json.discovered?.length ?? 0;
      setScanResult(count > 0 ? `${count} 件の新しいチャネルを検出しました（${json.discovered?.join(", ")}）。ページを更新してください。` : "新しいチャネルは見つかりませんでした。");
    } else {
      setScanResult("スキャン中にエラーが発生しました。");
    }
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      if (!confirm("このチャネルを削除します。過去のキャッシュも削除されます。よろしいですか？")) return;
      const formData = new FormData();
      formData.set("intent", "delete");
      formData.set("id", id);
      submit(formData, { method: "POST", replace: true });
      setChannels((prev) => prev.filter((c) => c.id !== id));
      setEditingId(null);
    },
    [submit]
  );

  return (
    <PolarisPageWrapper>
      <Page
        title="チャネル管理"
        subtitle="オンラインストア・外部モール等のチャネルを設定し、売上サマリーに表示します"
        backAction={{ content: "設定", onAction: () => navigate("/app/sales-summary-settings") }}
      >
        <TabGroupBar tabs={SETTINGS_TABS} />
        <Layout>
          <Layout.Section>
            {savedBanner && (
              <Banner tone="success" onDismiss={() => setSavedBanner(false)}>
                保存しました
              </Banner>
            )}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  登録チャネル
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  直近の注文から販売チャネルを自動検出できます。検出後は各チャネルを編集して表示名や集計設定を調整してください。
                </Text>
                <InlineStack gap="300" blockAlign="center">
                  <Button onClick={handleAutoDiscover} loading={isScanning}>
                    チャネルを自動検出
                  </Button>
                </InlineStack>
                {scanResult && (
                  <Banner tone="info" onDismiss={() => setScanResult(null)}>
                    {scanResult}
                  </Banner>
                )}

                {channels.length === 0 && !addingNew && (
                  <EmptyState
                    heading="チャネルが未登録です"
                    image=""
                    action={{ content: "チャネルを追加", onAction: () => setAddingNew(true) }}
                  >
                    <p>「チャネルを追加」からオンラインストアや外部モールを登録してください。</p>
                  </EmptyState>
                )}

                <BlockStack gap="300">
                  {channels.map((ch) => (
                    <Box key={ch.id} padding="400" background="bg-surface-secondary" borderRadius="200">
                      {editingId === ch.id ? (
                        <ChannelForm
                          channel={ch}
                          onSave={handleSave}
                          onCancel={() => setEditingId(null)}
                          onDelete={() => handleDelete(ch.id)}
                          isSaving={isSaving}
                        />
                      ) : (
                        <InlineStack align="space-between" blockAlign="center">
                          <BlockStack gap="100">
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="span" variant="bodyMd" fontWeight="semibold">
                                {ch.displayName || ch.name}
                              </Text>
                              {ch.salesSummaryEnabled ? (
                                <Badge tone="success">集計有効</Badge>
                              ) : (
                                <Badge tone="disabled">無効</Badge>
                              )}
                              {ch.includeInOverallTotals && (
                                <Badge>全体合計に含む</Badge>
                              )}
                            </InlineStack>
                            <Text as="span" variant="bodySm" tone="subdued">
                              source_name: {parseSourceNames(ch.sourceNamesJson) || "（未設定）"}
                            </Text>
                          </BlockStack>
                          <Button onClick={() => setEditingId(ch.id)}>編集</Button>
                        </InlineStack>
                      )}
                    </Box>
                  ))}
                </BlockStack>

                {addingNew && (
                  <>
                    <Divider />
                    <Text as="h3" variant="headingSm">新規チャネル追加</Text>
                    <ChannelForm
                      channel={EMPTY_CHANNEL}
                      onSave={handleSave}
                      onCancel={() => setAddingNew(false)}
                      isSaving={isSaving}
                    />
                  </>
                )}

                {!addingNew && channels.length > 0 && (
                  <Box>
                    <Button onClick={() => { setAddingNew(true); setEditingId(null); }}>
                      チャネルを追加
                    </Button>
                  </Box>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
