/**
 * /app/channel-budget-management — チャネル別日次予算（EC・マーケットプレイス等）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useLocation, useNavigate, useSearchParams, useFetcher } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  IndexTable,
  EmptyState,
  TextField,
  Box,
  Select,
  Banner,
  Divider,
  Checkbox,
} from "@shopify/polaris";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getFullAccess, checkPlanAccess } from "../utils/planFeatures.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, REPORTS_TABS } from "../components/TabGroupBar";

const PAGE_SIZE = 50;

function fmtYen(n: string | number) {
  return `¥${Number(n).toLocaleString("ja-JP")}`;
}

function monthOptions() {
  const now = new Date();
  const options = [{ label: "すべての月", value: "" }];
  for (let offset = -3; offset <= 12; offset++) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    options.push({ label: key, value: key });
  }
  return options;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.length > 0)) rows.push(row);
  return rows;
}

function normalizeHeaderCell(v: string) {
  return v.replace(/^\uFEFF/, "").trim().toLowerCase();
}

function normalizeName(v: string) {
  return v.replace(/\u3000/g, " ").trim().replace(/\s+/g, " ");
}

function parseBudgetAmount(raw: string): number | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[¥,\s]/g, "");
  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

async function importChannelBudgetsFromCsvText(params: { text: string; shopId: string }) {
  const { text, shopId } = params;
  const rows = parseCsvRows(text);
  let inserted = 0,
    updated = 0,
    skipped = 0;
  const errors: string[] = [];

  const channels = await prisma.salesChannel.findMany({ where: { shopId } });
  const nameToId = new Map(channels.map((c) => [normalizeName(c.name), c.id]));
  const unknownNameCounts = new Map<string, number>();

  const header = rows[0]?.map((s) => s.replace(/^\uFEFF/, "").trim()) ?? [];
  const normalized = header.map((h) => normalizeHeaderCell(h));
  const idxChName = header.findIndex((h) => h === "チャネル名");
  const idxDateJa = header.findIndex((h) => h === "日付");
  const idxBudgetJa = header.findIndex((h) => h === "予算");
  const idxChId = normalized.findIndex((h) => h === "channelid" || h === "channel_id");
  const idxDate = normalized.findIndex((h) => h === "targetdate" || h === "date");
  const idxAmount = normalized.findIndex((h) => h === "amount" || h === "budget");
  const hasHeader = [idxChName, idxDateJa, idxBudgetJa, idxChId, idxDate, idxAmount].some((i) => i >= 0);

  const dataRows = hasHeader ? rows.slice(1) : rows;
  for (const parts of dataRows) {
    if (parts.length < 3) {
      skipped++;
      continue;
    }

    const rawChName = idxChName >= 0 ? normalizeName(parts[idxChName] ?? "") : "";
    const rawDateJa = idxDateJa >= 0 ? (parts[idxDateJa] ?? "").trim() : "";
    const rawBudgetJa = idxBudgetJa >= 0 ? (parts[idxBudgetJa] ?? "").trim() : "";

    const rawChId = idxChId >= 0 ? (parts[idxChId] ?? "").trim() : (parts[0] ?? "").trim();
    const rawDate = idxDate >= 0 ? (parts[idxDate] ?? "").trim() : (parts[1] ?? "").trim();
    const rawAmount = idxAmount >= 0 ? (parts[idxAmount] ?? "").trim() : (parts[2] ?? "").trim();

    const targetDate = rawDateJa || rawDate;
    const amountRaw = rawBudgetJa || rawAmount;
    const amount = parseBudgetAmount(amountRaw);

    let channelId = "";
    if (rawChName) {
      channelId = nameToId.get(rawChName) ?? "";
    } else if (rawChId) {
      channelId = channels.some((c) => c.id === rawChId) ? rawChId : "";
    }

    if (!channelId && rawChName) {
      unknownNameCounts.set(rawChName, (unknownNameCounts.get(rawChName) ?? 0) + 1);
      errors.push(`チャネル名が一致しません: ${rawChName}`);
      continue;
    }
    if (amount === null) {
      skipped++;
      continue;
    }
    if (!channelId || !targetDate) {
      errors.push(`無効な行: ${parts.join(",")}`);
      continue;
    }
    try {
      const existing = await prisma.salesChannelBudget.findUnique({
        where: { shopId_channelId_targetDate: { shopId, channelId, targetDate } },
      });
      await prisma.salesChannelBudget.upsert({
        where: { shopId_channelId_targetDate: { shopId, channelId, targetDate } },
        update: { amount },
        create: { shopId, channelId, targetDate, amount },
      });
      existing ? updated++ : inserted++;
    } catch (e) {
      errors.push(`行エラー: ${parts.join(",")} - ${e instanceof Error ? e.message : "unknown"}`);
    }
  }
  if (unknownNameCounts.size > 0) {
    const details = Array.from(unknownNameCounts.entries())
      .map(([name, count]) => `${name}(${count}行)`)
      .join(" / ");
    errors.push(`チャネル名が一致しない行があります: ${details}`);
  }
  return { ok: true, inserted, updated, skipped, errors };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const url = new URL(request.url);
  const month = url.searchParams.get("month") ?? "";
  const channelId = url.searchParams.get("channelId") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));

  const fullAccess = await getFullAccess(admin, session);
  const access = checkPlanAccess(shop.planCode, "budget_management", fullAccess);

  const dateFrom = month ? `${month}-01` : undefined;
  const dateTo = month
    ? (() => {
        const [y, m] = month.split("-").map(Number);
        const last = new Date(y, m, 0);
        return `${month}-${String(last.getDate()).padStart(2, "0")}`;
      })()
    : undefined;

  const whereClean = {
    shopId: shop.id,
    ...(channelId ? { channelId } : {}),
    ...(dateFrom || dateTo
      ? {
          targetDate: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          },
        }
      : {}),
  };

  const [channels, total, items] = await Promise.all([
    prisma.salesChannel.findMany({
      where: { shopId: shop.id },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.salesChannelBudget.count({ where: whereClean }),
    prisma.salesChannelBudget.findMany({
      where: whereClean,
      orderBy: [{ targetDate: "asc" }, { channelId: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  const chName = new Map(channels.map((c) => [c.id, c.displayName ?? c.name]));

  return {
    items: items.map((b) => ({
      id: b.id,
      channelId: b.channelId,
      channelName: chName.get(b.channelId) ?? b.channelId,
      targetDate: b.targetDate,
      amount: b.amount.toString(),
      updatedAt: b.updatedAt.toISOString(),
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
    month,
    channelId,
    channels,
    hasAccess: access.allowed,
    planMessage: access.message,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const fullAccess = await getFullAccess(admin, session);
  const access = checkPlanAccess(shop.planCode, "budget_management", fullAccess);
  if (!access.allowed) {
    return Response.json({ ok: false, error: access.message }, { status: 403 });
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const intent = String(formData.get("intent") ?? "");
    if (intent === "csv_import") {
      const file = formData.get("csvFile");
      if (!(file instanceof File)) {
        return Response.json({ ok: false, error: "CSVファイルが見つかりません" }, { status: 400 });
      }
      const text = await file.text();
      return Response.json(await importChannelBudgetsFromCsvText({ text, shopId: shop.id }));
    }
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "upsert") {
    const cid = String(formData.get("channelId") ?? "");
    const targetDate = String(formData.get("targetDate") ?? "");
    const amount = Number(formData.get("amount") ?? 0);
    if (!cid || !targetDate || Number.isNaN(amount)) {
      return Response.json({ ok: false, error: "channelId, targetDate, amount が必要です" }, { status: 400 });
    }
    const exists = await prisma.salesChannel.findFirst({ where: { id: cid, shopId: shop.id } });
    if (!exists) {
      return Response.json({ ok: false, error: "チャネルが見つかりません" }, { status: 400 });
    }
    await prisma.salesChannelBudget.upsert({
      where: { shopId_channelId_targetDate: { shopId: shop.id, channelId: cid, targetDate } },
      update: { amount },
      create: { shopId: shop.id, channelId: cid, targetDate, amount },
    });
    return Response.json({ ok: true });
  }

  if (intent === "delete") {
    const id = String(formData.get("id") ?? "");
    if (id) {
      await prisma.salesChannelBudget.delete({ where: { id } });
    }
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { status: 400 });
}

export default function ChannelBudgetManagementPage() {
  const {
    items,
    total,
    page,
    pageSize,
    month,
    channelId,
    channels,
    hasAccess,
    planMessage,
  } = useLoaderData<typeof loader>();

  const location = useLocation();
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<{
    ok?: boolean;
    inserted?: number;
    updated?: number;
    skipped?: number;
    errors?: string[];
    error?: string;
  }>();
  const q = location.search || "";
  const to = (path: string) => () => navigate(path + q);

  const [newChId, setNewChId] = useState(channels[0]?.id ?? "");
  const [newDate, setNewDate] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [templateMonth, setTemplateMonth] = useState(month || monthOptions()[4]?.value || "");
  const [templateChannelIds, setTemplateChannelIds] = useState<string[]>(
    channelId ? [channelId] : channels.map((c) => c.id),
  );
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [selectedCsvFile, setSelectedCsvFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const json = fetcher.data;
    if (json.ok) {
      setImportResult(
        `インポート完了: 追加 ${json.inserted ?? 0}件 / 更新 ${json.updated ?? 0}件 / スキップ ${json.skipped ?? 0}件 / エラー ${json.errors?.length ?? 0}件`,
      );
      setImportError(null);
      setSelectedCsvFile(null);
      setUploading(false);
      navigate(location.pathname + location.search);
    } else if (json.error) {
      setImportError(json.error);
      setUploading(false);
    }
  }, [fetcher.state, fetcher.data, navigate, location.pathname, location.search]);

  const totalPages = Math.ceil(total / pageSize);
  const allChIds = channels.map((c) => c.id);
  const isAllTemplateChannelsChecked =
    allChIds.length > 0 && templateChannelIds.length === allChIds.length;

  const handleFilter = (key: string, value: string) => {
    const params = new URLSearchParams(location.search);
    if (value) params.set(key, value);
    else params.delete(key);
    params.set("page", "1");
    setSearchParams(params);
  };

  const gotoPage = (p: number) => {
    const params = new URLSearchParams(location.search);
    params.set("page", String(p));
    setSearchParams(params);
  };

  const handleAdd = () => {
    if (!newChId || !newDate || !newAmount) return;
    const fd = new FormData();
    fd.set("intent", "upsert");
    fd.set("channelId", newChId);
    fd.set("targetDate", newDate);
    fd.set("amount", newAmount);
    fetcher.submit(fd, { method: "post" });
    setNewDate("");
    setNewAmount("");
  };

  const handleDelete = (id: string) => {
    if (!confirm("このチャネル予算を削除しますか？")) return;
    const fd = new FormData();
    fd.set("intent", "delete");
    fd.set("id", id);
    fetcher.submit(fd, { method: "post" });
  };

  const handleCsvDownload = () => {
    if (!templateMonth || templateChannelIds.length === 0) {
      setImportError("テンプレートDLには月とチャネルの指定が必要です。");
      return;
    }
    setImportError(null);
    const form = document.createElement("form");
    form.method = "POST";
    form.action = `/app/channel-budget-template-csv${location.search || ""}`;
    const monthInput = document.createElement("input");
    monthInput.type = "hidden";
    monthInput.name = "templateMonth";
    monthInput.value = templateMonth;
    form.appendChild(monthInput);
    const chInput = document.createElement("input");
    chInput.type = "hidden";
    chInput.name = "templateChannelIds";
    chInput.value = JSON.stringify(templateChannelIds);
    form.appendChild(chInput);
    document.body.appendChild(form);
    form.submit();
    form.remove();
  };

  const handleCsvUpload = async () => {
    if (!selectedCsvFile) {
      setImportError("先にCSVファイルを選択してください。");
      return;
    }
    setUploading(true);
    setImportError(null);
    setImportResult(null);
    const fd = new FormData();
    fd.set("intent", "csv_import");
    fd.set("csvFile", selectedCsvFile);
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  };

  const channelOptions = [
    { label: "すべて", value: "" },
    ...channels.map((c) => ({ label: c.displayName ?? c.name, value: c.id })),
  ];

  const toggleTemplateChannel = (cid: string) => {
    setTemplateChannelIds((prev) =>
      prev.includes(cid) ? prev.filter((id) => id !== cid) : [...prev, cid],
    );
  };

  const resourceName = { singular: "チャネル予算", plural: "チャネル予算" };

  return (
    <PolarisPageWrapper>
      <Page title="チャネル予算" backAction={{ content: "戻る", onAction: to("/app") }}>
        {!hasAccess && (
          <Box paddingBlockEnd="400">
            <Banner tone="warning">
              <Text as="p">{planMessage}</Text>
            </Banner>
          </Box>
        )}

        <Card padding="0">
          <TabGroupBar tabs={REPORTS_TABS} />
        </Card>

        <Layout>
          <Layout.Section>
            <Banner tone="info">
              <Text as="p">
                チャネルは「設定 → チャネル管理」で登録し、売上サマリー対象をONにしてください。CSVは「チャネル名,日付,予算」形式です（テンプレートをDLできます）。
              </Text>
            </Banner>
          </Layout.Section>

          {channels.length === 0 && (
            <Layout.Section>
              <Banner tone="warning">
                <Text as="p">まだチャネルが登録されていません。チャネル管理から追加してください。</Text>
              </Banner>
            </Layout.Section>
          )}

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="400" wrap>
                  <Box minWidth="200px">
                    <Select
                      label="月"
                      options={monthOptions()}
                      value={month}
                      onChange={(v) => handleFilter("month", v)}
                    />
                  </Box>
                  <Box minWidth="220px">
                    <Select
                      label="チャネル"
                      options={channelOptions}
                      value={channelId}
                      onChange={(v) => handleFilter("channelId", v)}
                    />
                  </Box>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingSm">
                  追加 / 更新
                </Text>
                <InlineStack gap="300" wrap>
                  <Box minWidth="200px">
                    <Select
                      label="チャネル"
                      options={channels.map((c) => ({
                        label: c.displayName ?? c.name,
                        value: c.id,
                      }))}
                      value={newChId}
                      onChange={setNewChId}
                      disabled={channels.length === 0}
                    />
                  </Box>
                  <Box minWidth="140px">
                    <TextField
                      label="日付（YYYY-MM-DD）"
                      value={newDate}
                      onChange={setNewDate}
                      autoComplete="off"
                    />
                  </Box>
                  <Box minWidth="140px">
                    <TextField
                      label="予算（円）"
                      value={newAmount}
                      onChange={setNewAmount}
                      type="number"
                      autoComplete="off"
                    />
                  </Box>
                  <Box paddingBlockStart="400">
                    <Button variant="primary" onClick={handleAdd} disabled={!hasAccess || channels.length === 0}>
                      保存
                    </Button>
                  </Box>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingSm">
                  CSV テンプレート・インポート
                </Text>
                <InlineStack gap="300" wrap>
                  <Box minWidth="160px">
                    <Select
                      label="テンプレート対象月"
                      options={monthOptions().filter((o) => o.value)}
                      value={templateMonth}
                      onChange={setTemplateMonth}
                    />
                  </Box>
                  <Button onClick={handleCsvDownload} disabled={!hasAccess || channels.length === 0}>
                    テンプレートDL
                  </Button>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  テンプレートに含めるチャネル
                </Text>
                <BlockStack gap="200">
                  {channels.length > 0 && (
                    <Checkbox
                      label="すべて選択 / 解除"
                      checked={isAllTemplateChannelsChecked}
                      onChange={(v) =>
                        setTemplateChannelIds(v ? [...allChIds] : [])
                      }
                    />
                  )}
                  {channels.map((c) => (
                    <Checkbox
                      key={c.id}
                      label={c.displayName ?? c.name}
                      checked={templateChannelIds.includes(c.id)}
                      onChange={() => toggleTemplateChannel(c.id)}
                    />
                  ))}
                </BlockStack>
                <Divider />
                <input type="file" accept=".csv,text/csv" onChange={(e) => setSelectedCsvFile(e.target.files?.[0] ?? null)} />
                <Button onClick={handleCsvUpload} loading={uploading} disabled={!hasAccess}>
                  CSV を取り込む
                </Button>
                {importError ? (
                  <Text as="p" tone="critical">
                    {importError}
                  </Text>
                ) : null}
                {importResult ? (
                  <Text as="p" tone="success">
                    {importResult}
                  </Text>
                ) : null}
                {fetcher.data?.errors && fetcher.data.errors.length > 0 ? (
                  <BlockStack gap="100">
                    {fetcher.data.errors.slice(0, 20).map((err) => (
                      <Text key={err} as="p" variant="bodySm" tone="critical">
                        {err}
                      </Text>
                    ))}
                  </BlockStack>
                ) : null}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card padding="0">
              <IndexTable
                resourceName={resourceName}
                itemCount={items.length}
                headings={[
                  { title: "チャネル" },
                  { title: "日付" },
                  { title: "予算" },
                  { title: "操作" },
                ]}
                selectable={false}
                emptyState={
                  <EmptyState heading="データがありません" image="">
                    <Text as="p" tone="subdued">
                      条件を変えるか、上のフォーム・CSVで登録してください。
                    </Text>
                  </EmptyState>
                }
              >
                {items.map((row, index) => (
                  <IndexTable.Row id={row.id} key={row.id} position={index}>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {row.channelName}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{row.targetDate}</IndexTable.Cell>
                    <IndexTable.Cell>{fmtYen(row.amount)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <Button
                        tone="critical"
                        variant="plain"
                        disabled={!hasAccess}
                        onClick={() => handleDelete(row.id)}
                      >
                        削除
                      </Button>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>
            {totalPages > 1 ? (
              <Box paddingBlockStart="400">
                <InlineStack gap="200" align="center">
                  <Button disabled={page <= 1} onClick={() => gotoPage(page - 1)}>
                    前へ
                  </Button>
                  <Text as="span">
                    {page} / {totalPages}（全 {total} 件）
                  </Text>
                  <Button disabled={page >= totalPages} onClick={() => gotoPage(page + 1)}>
                    次へ
                  </Button>
                </InlineStack>
              </Box>
            ) : null}
          </Layout.Section>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
