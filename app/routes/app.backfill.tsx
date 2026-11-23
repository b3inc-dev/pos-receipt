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
import { SystemPageNav } from "../components/SystemPageNav";
import { AdminIntro, SuccessToast } from "../components/admin-ui";
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
  const errorCount = dayResults.filter((r) => r.status === "error").length;
  const stopped = !running && total > 0 && !done;
  // 状態はバッジで 1 行に出す（処理中・完了・停止中・要確認。UI ルール v1.1 12章）
  const runState: { label: string; tone?: "info" | "success" | "warning" } = running
    ? { label: "処理中", tone: "info" }
    : stopped
    ? { label: "停止中" }
    : errorCount > 0
    ? { label: "要確認", tone: "warning" }
    : { label: "完了", tone: "success" };

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
        <SystemPageNav memberCardEnabled={memberCardEnabled} />
        <Layout>
          <Layout.Section>
            {/* 画面全体の説明は AdminIntro（1〜2文）。開発用の名前（テーブル名）は出さない（UI ルール v1.1 5章・10章） */}
            <AdminIntro>
              <p>
                選んだ月の売上サマリーの集計を、1日ずつ取り込みます。取込済みの日は飛ばすので、止めたあとは「続きから再開」で残りの日を進めます。画面を閉じると止まります。
              </p>
            </AdminIntro>
            {/* 終わったらトーストで知らせる（成功は画面に残さない。UI ルール v1.1 5章） */}
            <SuccessToast message={done && errorCount === 0 ? "取込完了しました" : null} trigger={dayResults} />
            {/* 止まった・失敗した日があるときは、お知らせ枠 1 つに理由を出す（UI ルール v1.1 5章・12章） */}
            {!running && errorCount > 0 && (
              <Box paddingBlockStart="300">
                <Banner tone="critical">
                  <Text as="p">{errorCount}日を取り込めませんでした。日ごとの理由は下の進捗にあります。「続きから再開」で取り込めなかった日をもう一度試します。</Text>
                </Banner>
              </Box>
            )}
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
                          {stopped || errorCount > 0 ? "続きから再開" : "取込開始"}
                        </Button>
                      ) : (
                        <Button onClick={handleStop}>
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
                  <Text variant="headingSm" as="h2">進捗</Text>
                  {/* 状態のバッジと件数を 1 行で（UI ルール v1.1 12章） */}
                  <div role="status">
                    <InlineStack gap="200" align="space-between" blockAlign="center">
                      <Badge tone={runState.tone}>{runState.label}</Badge>
                      <span className="History-num">{processed} / {total}日（{progress}%）</span>
                    </InlineStack>
                  </div>
                  <ProgressBar progress={progress} size="small" />
                  <Box maxHeight="400px" overflowY="scroll">
                    <BlockStack gap="100">
                      {dayResults.map((r) => (
                        <InlineStack key={r.targetDate} gap="200" align="start" blockAlign="center">
                          <span className="History-num" style={{ minWidth: "110px", textAlign: "left", color: "#6d7175" }}>
                            {r.targetDate.replace(/-/g, "/")}
                          </span>
                          {r.status === "pending" && <Badge>待機中</Badge>}
                          {r.status === "processing" && <Badge tone="info">処理中</Badge>}
                          {r.status === "done" && <Badge tone="success">取込済</Badge>}
                          {r.status === "skipped" && <Badge>スキップ</Badge>}
                          {r.status === "error" && (
                            <>
                              <Badge tone="critical">失敗</Badge>
                              {r.reason ? <Text as="span" variant="bodySm" tone="subdued">{r.reason}</Text> : null}
                            </>
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
