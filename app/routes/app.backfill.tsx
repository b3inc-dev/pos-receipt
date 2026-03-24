/**
 * /app/backfill — 過去データ一括取込
 * 管理画面向け：SalesSummaryCacheDaily を指定期間分バックフィル
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useLocation, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Select,
  Banner,
  Box,
  ProgressBar,
  Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import prisma from "../db.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, buildSystemTabs } from "../components/TabGroupBar";
import { isInhouseMode } from "../utils/planFeatures.server";
import { useState, useCallback, useRef } from "react";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const locations = await prisma.location.findMany({
    where: { shopId: shop.id },
    select: { shopifyLocationGid: true, name: true },
    orderBy: { name: "asc" },
  });
  return { locations, memberCardEnabled: isInhouseMode() };
}

function buildMonthOptions() {
  const options = [];
  const now = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    options.push({ label: `${y}年${d.getMonth() + 1}月`, value: `${y}-${m}` });
  }
  return options;
}

function getDaysInMonth(ym: string): string[] {
  const [y, m] = ym.split("-").map(Number);
  const today = new Date().toISOString().slice(0, 10);
  const lastDay = new Date(y, m, 0).getDate();
  const days: string[] = [];
  for (let d = 1; d <= lastDay; d++) {
    const ds = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (ds > today) break;
    days.push(ds);
  }
  return days;
}

type DayResult = { targetDate: string; status: "pending" | "processing" | "done" | "skipped" | "error"; reason?: string };

export default function BackfillPage() {
  const { locations, memberCardEnabled } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const location = useLocation();

  const monthOptions = buildMonthOptions();
  const locationOptions = locations.map((l) => ({
    label: l.name,
    value: l.shopifyLocationGid,
  }));

  const [selectedLocation, setSelectedLocation] = useState(locationOptions[0]?.value ?? "");
  const [selectedMonth, setSelectedMonth] = useState(monthOptions[0]?.value ?? "");
  const [running, setRunning] = useState(false);
  const [dayResults, setDayResults] = useState<DayResult[]>([]);
  const [error, setError] = useState("");
  const abortRef = useRef(false);

  const processed = dayResults.filter((r) => r.status === "done" || r.status === "skipped" || r.status === "error").length;
  const total = dayResults.length;
  const progress = total > 0 ? Math.round((processed / total) * 100) : 0;
  const done = total > 0 && processed === total;

  const handleStart = useCallback(async () => {
    if (!selectedLocation || !selectedMonth) return;
    abortRef.current = false;
    setError("");

    const loc = locations.find((l) => l.shopifyLocationGid === selectedLocation);
    const days = getDaysInMonth(selectedMonth);
    const initial: DayResult[] = days.map((d) => ({ targetDate: d, status: "pending" }));
    setDayResults(initial);
    setRunning(true);

    for (let i = 0; i < days.length; i++) {
      if (abortRef.current) break;
      const day = days[i];
      setDayResults((prev) =>
        prev.map((r) => (r.targetDate === day ? { ...r, status: "processing" } : r))
      );
      try {
        const res = await fetch("/api/admin/backfill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            locationId: selectedLocation,
            locationName: loc?.name ?? "",
            targetDate: day,
            skipExisting: true,
          }),
        });
        const json = await res.json() as { ok: boolean; skipped?: boolean; reason?: string; error?: string };
        if (json.ok) {
          setDayResults((prev) =>
            prev.map((r) =>
              r.targetDate === day
                ? { ...r, status: json.skipped ? "skipped" : "done", reason: json.reason }
                : r
            )
          );
        } else {
          setDayResults((prev) =>
            prev.map((r) =>
              r.targetDate === day ? { ...r, status: "error", reason: json.error } : r
            )
          );
        }
      } catch (e) {
        setDayResults((prev) =>
          prev.map((r) =>
            r.targetDate === day
              ? { ...r, status: "error", reason: e instanceof Error ? e.message : "Network error" }
              : r
          )
        );
      }
    }
    setRunning(false);
  }, [selectedLocation, selectedMonth, locations]);

  const handleStop = useCallback(() => {
    abortRef.current = true;
  }, []);

  const q = location.search || "";
  const to = (path: string) => () => navigate(path + q);

  return (
    <PolarisPageWrapper>
      <Page
        title="過去データ一括取込"
        backAction={{ content: "ホーム", onAction: to("/app") }}
      >
        <Card padding="0">
          <TabGroupBar tabs={buildSystemTabs(memberCardEnabled)} />
        </Card>
        <Layout>
          <Layout.Section>
            <Banner tone="info">
              <Text as="p">
                指定した月のSalesSummaryCacheDailyを1日ずつ取得します。
                キャッシュ済みの日はスキップされます。月単位で実行してください。
              </Text>
            </Banner>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text variant="headingSm" as="h2">取込設定</Text>
                {locationOptions.length === 0 ? (
                  <Text as="p" tone="subdued">ロケーションが登録されていません。先に設定ページでロケーションを同期してください。</Text>
                ) : (
                  <>
                    <Select
                      label="ロケーション"
                      options={locationOptions}
                      value={selectedLocation}
                      onChange={setSelectedLocation}
                      disabled={running}
                    />
                    <Select
                      label="対象月"
                      options={monthOptions}
                      value={selectedMonth}
                      onChange={setSelectedMonth}
                      disabled={running}
                    />
                    <InlineStack gap="300">
                      {!running ? (
                        <Button variant="primary" onClick={handleStart} disabled={!selectedLocation || !selectedMonth}>
                          取込開始
                        </Button>
                      ) : (
                        <Button onClick={handleStop} tone="critical">
                          停止
                        </Button>
                      )}
                    </InlineStack>
                  </>
                )}
                {error && <Text as="p" tone="critical">{error}</Text>}
              </BlockStack>
            </Card>
          </Layout.Section>

          {dayResults.length > 0 && (
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text variant="headingSm" as="h2">進捗</Text>
                    <Text as="span" tone="subdued">{processed} / {total}日 ({progress}%)</Text>
                  </InlineStack>
                  <ProgressBar progress={progress} size="small" />
                  {done && (
                    <Banner tone="success">
                      <Text as="p">取込完了しました。</Text>
                    </Banner>
                  )}
                  <Box maxHeight="400px" overflowY="scroll">
                    <BlockStack gap="100">
                      {dayResults.map((r) => (
                        <InlineStack key={r.targetDate} gap="200" align="start">
                          <Text as="span" variant="bodySm" tone="subdued" style={{ minWidth: "110px" }}>
                            {r.targetDate}
                          </Text>
                          {r.status === "pending" && <Badge>待機中</Badge>}
                          {r.status === "processing" && <Badge tone="attention">処理中…</Badge>}
                          {r.status === "done" && <Badge tone="success">取込済</Badge>}
                          {r.status === "skipped" && <Badge tone="info">スキップ</Badge>}
                          {r.status === "error" && (
                            <Badge tone="critical">エラー: {r.reason ?? ""}</Badge>
                          )}
                        </InlineStack>
                      ))}
                    </BlockStack>
                  </Box>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
