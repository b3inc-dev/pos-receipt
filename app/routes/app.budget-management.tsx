/**
 * /app/budget-management — 予算管理
 * 要件書 §10.1C, §19.3, §24.2: 予算一覧・手動編集・CSVインポート
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useLocation, useNavigate, useSearchParams, useFetcher } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  Checkbox,
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
  InlineGrid,
} from "@shopify/polaris";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getFullAccess, checkPlanAccess } from "../utils/planFeatures.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, REPORTS_TABS } from "../components/TabGroupBar";

const PAGE_SIZE = 50;

const LOCATIONS_QUERY = `#graphql
  query Locations {
    locations(first: 50, includeLegacy: false) {
      nodes { id name isActive }
    }
  }
`;

function fmtYen(n: string | number) {
  return `¥${Number(n).toLocaleString("ja-JP")}`;
}

/** YYYY-MM の一覧を今月から前後で生成 */
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

function daysInMonthFromKey(monthKey: string) {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return 0;
  return new Date(y, m, 0).getDate();
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const url = new URL(request.url);
  const month      = url.searchParams.get("month")      ?? "";
  const locationId = url.searchParams.get("locationId") ?? "";
  const page       = Math.max(1, Number(url.searchParams.get("page") ?? "1"));

  // Shopify ロケーション一覧
  const locRes  = await admin.graphql(LOCATIONS_QUERY);
  const locJson = await locRes.json() as {
    data?: { locations?: { nodes?: { id: string; name: string; isActive: boolean }[] } };
  };
  const shopifyLocations = (locJson.data?.locations?.nodes ?? []).filter((l) => l.isActive);

  // プランチェック（自社用 or Pro のみ）
  const fullAccess = await getFullAccess(admin, session);
  const access = checkPlanAccess(shop.planCode, "budget_management", fullAccess);

  // フィルタ条件
  const dateFrom = month ? `${month}-01` : undefined;
  const dateTo   = month
    ? (() => {
        const [y, m] = month.split("-").map(Number);
        const last = new Date(y, m, 0);
        return `${month}-${String(last.getDate()).padStart(2, "0")}`;
      })()
    : undefined;

  const whereClean = {
    shopId: shop.id,
    ...(locationId ? { locationId } : {}),
    ...(dateFrom || dateTo
      ? {
          targetDate: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo   ? { lte: dateTo }   : {}),
          },
        }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.budget.count({ where: whereClean }),
    prisma.budget.findMany({
      where: whereClean,
      orderBy: [{ targetDate: "asc" }, { locationId: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  const locationMap = new Map(shopifyLocations.map((l) => [l.id, l.name]));

  return {
    items: items.map((b) => ({
      id: b.id,
      locationId: b.locationId,
      locationName: locationMap.get(b.locationId) ?? b.locationId,
      targetDate: b.targetDate,
      amount: b.amount.toString(),
      updatedAt: b.updatedAt.toISOString(),
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
    month,
    locationId,
    shopifyLocations,
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

  // CSV インポート
  if (contentType.includes("text/csv") || contentType.includes("application/octet-stream")) {
    const text = await request.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    let inserted = 0, updated = 0, skipped = 0;
    const errors: string[] = [];
    const locRes = await admin.graphql(LOCATIONS_QUERY);
    const locJson = await locRes.json() as {
      data?: { locations?: { nodes?: { id: string; name: string; isActive: boolean }[] } };
    };
    const activeLocations = (locJson.data?.locations?.nodes ?? []).filter((l) => l.isActive);
    const locationNameToId = new Map(activeLocations.map((l) => [l.name.trim(), l.id]));

    // ヘッダー解析（DLテンプレート: ロケーション名,日付,予算 / 従来: locationId,targetDate,amount）
    const header = lines[0]?.split(",").map((s) => s.trim()) ?? [];
    const normalized = header.map((h) => h.toLowerCase());
    const idxLocName = header.findIndex((h) => h === "ロケーション名");
    const idxDateJa = header.findIndex((h) => h === "日付");
    const idxBudgetJa = header.findIndex((h) => h === "予算");
    const idxLocId = normalized.findIndex((h) => h === "locationid" || h === "location");
    const idxDate = normalized.findIndex((h) => h === "targetdate" || h === "date");
    const idxAmount = normalized.findIndex((h) => h === "amount" || h === "budget");
    const hasHeader = [idxLocName, idxDateJa, idxBudgetJa, idxLocId, idxDate, idxAmount].some((i) => i >= 0);

    const dataLines = hasHeader ? lines.slice(1) : lines;
    for (const line of dataLines) {
      const parts = line.split(",");
      if (parts.length < 3) {
        skipped++;
        continue;
      }

      const rawLocName = idxLocName >= 0 ? (parts[idxLocName] ?? "").trim() : "";
      const rawDateJa = idxDateJa >= 0 ? (parts[idxDateJa] ?? "").trim() : "";
      const rawBudgetJa = idxBudgetJa >= 0 ? (parts[idxBudgetJa] ?? "").trim() : "";

      const rawLocId = idxLocId >= 0 ? (parts[idxLocId] ?? "").trim() : (parts[0] ?? "").trim();
      const rawDate = idxDate >= 0 ? (parts[idxDate] ?? "").trim() : (parts[1] ?? "").trim();
      const rawAmount = idxAmount >= 0 ? (parts[idxAmount] ?? "").trim() : (parts[2] ?? "").trim();

      const targetDate = rawDateJa || rawDate;
      const amountRaw = rawBudgetJa || rawAmount;
      const amount = Number(amountRaw);

      let locationId = "";
      if (rawLocName) {
        locationId = locationNameToId.get(rawLocName) ?? "";
      } else if (rawLocId) {
        locationId = rawLocId.startsWith("gid://")
          ? rawLocId
          : `gid://shopify/Location/${rawLocId}`;
      }

      if (!locationId || !targetDate || isNaN(amount)) {
        errors.push(`無効な行: ${line}`);
        continue;
      }
      try {
        const existing = await prisma.budget.findUnique({
          where: { shopId_locationId_targetDate: { shopId: shop.id, locationId, targetDate } },
        });
        await prisma.budget.upsert({
          where: { shopId_locationId_targetDate: { shopId: shop.id, locationId, targetDate } },
          update: { amount },
          create: { shopId: shop.id, locationId, targetDate, amount },
        });
        existing ? updated++ : inserted++;
      } catch (e) {
        errors.push(`行エラー: ${line} - ${e instanceof Error ? e.message : "unknown"}`);
      }
    }
    return Response.json({ ok: true, inserted, updated, skipped, errors });
  }

  // 手動 upsert
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "upsert") {
    const locationId = String(formData.get("locationId") ?? "");
    const targetDate = String(formData.get("targetDate") ?? "");
    const amount     = Number(formData.get("amount") ?? 0);

    if (!locationId || !targetDate || isNaN(amount)) {
      return Response.json({ ok: false, error: "locationId, targetDate, amount が必要です" }, { status: 400 });
    }

    await prisma.budget.upsert({
      where: { shopId_locationId_targetDate: { shopId: shop.id, locationId, targetDate } },
      update: { amount },
      create: { shopId: shop.id, locationId, targetDate, amount },
    });
    return Response.json({ ok: true });
  }

  if (intent === "delete") {
    const id = String(formData.get("id") ?? "");
    if (id) {
      await prisma.budget.delete({ where: { id } });
    }
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { status: 400 });
}

export default function BudgetManagementPage() {
  const {
    items, total, page, pageSize, month, locationId,
    shopifyLocations, hasAccess, planMessage,
  } = useLoaderData<typeof loader>();

  const location = useLocation();
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const fetcher = useFetcher();
  const q = location.search || "";
  const to = (path: string) => () => navigate(path + q);

  const [newLocId, setNewLocId]   = useState(shopifyLocations[0]?.id ?? "");
  const [newDate, setNewDate]     = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [templateMonth, setTemplateMonth] = useState(month || monthOptions()[4]?.value || "");
  const [templateLocationIds, setTemplateLocationIds] = useState<string[]>(
    locationId ? [locationId] : shopifyLocations.map((l) => l.id)
  );
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [selectedCsvFile, setSelectedCsvFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const totalPages = Math.ceil(total / pageSize);
  const allTemplateLocationIds = shopifyLocations.map((l) => l.id);
  const isAllTemplateLocationsChecked =
    allTemplateLocationIds.length > 0 &&
    templateLocationIds.length === allTemplateLocationIds.length;

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const savedMonth = localStorage.getItem("budgetTemplateMonth");
      const savedLocationIds = localStorage.getItem("budgetTemplateLocationIds");
      if (savedMonth) setTemplateMonth(savedMonth);
      if (savedLocationIds) {
        const parsed = JSON.parse(savedLocationIds) as string[];
        const valid = parsed.filter((id) => allTemplateLocationIds.includes(id));
        if (valid.length > 0) setTemplateLocationIds(valid);
      }
    } catch {
      // In embedded iframe environments, storage access may be blocked.
    }
  }, [allTemplateLocationIds.join(",")]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem("budgetTemplateMonth", templateMonth);
    } catch {
      // ignore storage errors in restricted browser contexts
    }
  }, [templateMonth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem("budgetTemplateLocationIds", JSON.stringify(templateLocationIds));
    } catch {
      // ignore storage errors in restricted browser contexts
    }
  }, [templateLocationIds]);

  const handleFilter = (key: string, value: string) => {
    const params = new URLSearchParams(location.search);
    if (value) params.set(key, value); else params.delete(key);
    params.set("page", "1");
    setSearchParams(params);
  };

  const gotoPage = (p: number) => {
    const params = new URLSearchParams(location.search);
    params.set("page", String(p));
    setSearchParams(params);
  };

  const handleAddBudget = () => {
    if (!newLocId || !newDate || !newAmount) return;
    const fd = new FormData();
    fd.set("intent", "upsert");
    fd.set("locationId", newLocId);
    fd.set("targetDate", newDate);
    fd.set("amount", newAmount);
    fetcher.submit(fd, { method: "post" });
    setNewDate("");
    setNewAmount("");
  };

  const handleDelete = (id: string) => {
    if (!confirm("この予算レコードを削除しますか？")) return;
    const fd = new FormData();
    fd.set("intent", "delete");
    fd.set("id", id);
    fetcher.submit(fd, { method: "post" });
  };

  const handleCsvDownload = () => {
    if (!templateMonth || templateLocationIds.length === 0) {
      setImportError("テンプレートDLには月とロケーションの指定が必要です。");
      return;
    }
    setImportError(null);
    // POS Stock と同じく、CSV専用ルートへ通常フォームPOSTでダウンロードする。
    const form = document.createElement("form");
    form.method = "POST";
    form.action = `/app/budget-template-csv${location.search || ""}`;

    const monthInput = document.createElement("input");
    monthInput.type = "hidden";
    monthInput.name = "templateMonth";
    monthInput.value = templateMonth;
    form.appendChild(monthInput);

    const locationsInput = document.createElement("input");
    locationsInput.type = "hidden";
    locationsInput.name = "templateLocationIds";
    locationsInput.value = JSON.stringify(templateLocationIds);
    form.appendChild(locationsInput);

    document.body.appendChild(form);
    form.submit();
    form.remove();
  };

  const handleCsvFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedCsvFile(file);
    if (file) {
      setImportError(null);
      setImportResult(`選択済み: ${file.name}`);
    }
  };

  const handleCsvUpload = async () => {
    if (!selectedCsvFile) {
      setImportError("先にCSVファイルを選択してください。");
      return;
    }
    setUploading(true);
    setImportError(null);
    setImportResult(null);
    try {
      const text = await selectedCsvFile.text();
      const res = await fetch(location.pathname + location.search, {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: text,
      });
      const json = await res.json() as {
        ok: boolean;
        inserted?: number;
        updated?: number;
        skipped?: number;
        errors?: string[];
        error?: string;
      };
      if (json.ok) {
        setImportResult(
          `インポート完了: 追加 ${json.inserted ?? 0}件 / 更新 ${json.updated ?? 0}件 / スキップ ${json.skipped ?? 0}件 / エラー ${json.errors?.length ?? 0}件`
        );
        setSelectedCsvFile(null);
        navigate(location.pathname + location.search); // reload
      } else {
        setImportError(json.error ?? "インポートに失敗しました");
      }
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "インポート中に不明なエラーが発生しました");
    } finally {
      setUploading(false);
    }
  };

  const locationOptions = [
    { label: "すべて", value: "" },
    ...shopifyLocations.map((l) => ({ label: l.name, value: l.id })),
  ];
  const toggleTemplateLocation = (locId: string) => {
    setTemplateLocationIds((prev) =>
      prev.includes(locId) ? prev.filter((id) => id !== locId) : [...prev, locId]
    );
  };

  const resourceName = { singular: "予算", plural: "予算" };

  return (
    <PolarisPageWrapper>
      <Page
        title="予算管理"
        backAction={{ content: "戻る", onAction: to("/app") }}
      >
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
          {/* フィルター */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" as="h2">絞り込み</Text>
                <InlineStack gap="300" align="start" wrap>
                  <Box minWidth="180px">
                    <Select
                      label="月"
                      options={monthOptions()}
                      value={month}
                      onChange={(v) => handleFilter("month", v)}
                    />
                  </Box>
                  <Box minWidth="200px">
                    <Select
                      label="ロケーション"
                      options={locationOptions}
                      value={locationId}
                      onChange={(v) => handleFilter("locationId", v)}
                    />
                  </Box>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* 予算追加フォーム */}
          {hasAccess && (
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text variant="headingSm" as="h2">予算を追加 / 更新</Text>
                  <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                    <Select
                      label="ロケーション"
                      options={shopifyLocations.map((l) => ({ label: l.name, value: l.id }))}
                      value={newLocId}
                      onChange={setNewLocId}
                    />
                    <TextField
                      label="日付 (YYYY-MM-DD)"
                      type="date"
                      value={newDate}
                      onChange={setNewDate}
                      autoComplete="off"
                    />
                    <TextField
                      label="予算金額（円）"
                      type="number"
                      value={newAmount}
                      onChange={setNewAmount}
                      prefix="¥"
                      autoComplete="off"
                    />
                  </InlineGrid>
                  <Button
                    variant="primary"
                    onClick={handleAddBudget}
                    disabled={!newLocId || !newDate || !newAmount}
                    loading={fetcher.state === "submitting"}
                  >
                    保存
                  </Button>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {/* CSVインポート */}
          {hasAccess && (
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text variant="headingSm" as="h2">CSVテンプレートDL（日別）</Text>
                  <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                    <Select
                      label="対象月"
                      options={monthOptions().filter((m) => m.value)}
                      value={templateMonth}
                      onChange={setTemplateMonth}
                    />
                    <Box>
                      <BlockStack gap="200">
                        <Text as="p" variant="bodySm" fontWeight="semibold">
                          ロケーション（複数選択可）
                        </Text>
                        <InlineStack gap="200" wrap>
                          <Button
                            size="slim"
                            onClick={() => setTemplateLocationIds(allTemplateLocationIds)}
                            disabled={isAllTemplateLocationsChecked}
                          >
                            全選択
                          </Button>
                          <Button
                            size="slim"
                            onClick={() => setTemplateLocationIds([])}
                            disabled={templateLocationIds.length === 0}
                          >
                            全解除
                          </Button>
                        </InlineStack>
                        <BlockStack gap="100">
                          {shopifyLocations.map((l) => (
                            <Checkbox
                              key={`template-loc-${l.id}`}
                              label={l.name}
                              checked={templateLocationIds.includes(l.id)}
                              onChange={() => toggleTemplateLocation(l.id)}
                            />
                          ))}
                        </BlockStack>
                      </BlockStack>
                    </Box>
                    <Box>
                      <Text as="p" tone="subdued">
                        選択中: {templateLocationIds.length}件
                      </Text>
                    </Box>
                    <Box>
                      <Button variant="primary" onClick={handleCsvDownload}>
                        テンプレートをダウンロード
                      </Button>
                    </Box>
                  </InlineGrid>
                  <Text as="p" tone="subdued">
                    ヘッダーは「ロケーション名,日付,予算」です。選択した月の日付を1日ずつ展開し、既存の日別予算があれば予算列に入ります。
                  </Text>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {hasAccess && (
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text variant="headingSm" as="h2">CSVインポート</Text>
                  <Text as="p" tone="subdued">
                    フォーマットは「ロケーション名,日付,予算」（テンプレート）または「locationId,targetDate,amount」（従来）に対応しています。
                  </Text>
                  {importError && <Banner tone="critical"><Text as="p">{importError}</Text></Banner>}
                  {importResult && <Banner tone="success"><Text as="p">{importResult}</Text></Banner>}
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={handleCsvFileSelect}
                    style={{ fontSize: "14px" }}
                  />
                  <InlineStack align="start">
                    <Button variant="primary" onClick={handleCsvUpload} loading={uploading} disabled={!selectedCsvFile}>
                      アップロード実行
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {/* 予算一覧テーブル */}
          <Layout.Section>
            <Card padding="0">
              <IndexTable
                resourceName={resourceName}
                itemCount={items.length}
                headings={[
                  { title: "日付" },
                  { title: "ロケーション" },
                  { title: "予算金額" },
                  { title: "最終更新" },
                  { title: "" },
                ]}
                selectable={false}
                emptyState={
                  <EmptyState
                    heading="予算データがありません"
                    image=""
                  >
                    <Text as="p" tone="subdued">
                      上のフォームから予算を追加するか、CSVをインポートしてください。
                    </Text>
                  </EmptyState>
                }
              >
                {items.map((item, idx) => (
                  <IndexTable.Row id={item.id} key={item.id} position={idx}>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {item.targetDate}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{item.locationName}</IndexTable.Cell>
                    <IndexTable.Cell>{fmtYen(item.amount)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {new Date(item.updatedAt).toLocaleString("ja-JP", {
                          year: "numeric", month: "2-digit", day: "2-digit",
                          hour: "2-digit", minute: "2-digit",
                        })}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {hasAccess && (
                        <Button
                          tone="critical"
                          variant="plain"
                          size="slim"
                          onClick={() => handleDelete(item.id)}
                        >
                          削除
                        </Button>
                      )}
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
