/**
 * /app/backfill — 過去データ一括取込
 * 管理画面向け：SalesSummaryCacheDaily を指定期間分バックフィル
 * キューが使えるときは裏で 1 日ずつ進める（画面を閉じても続く。T さんの決定 2026-11-22・UI ルール v1.1 12章）。
 * 使えないとき（BACKFILL_QUEUE=0 など）は、今までどおり画面から 1 日ずつ送る。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useLocation, useNavigate, useRevalidator } from "react-router";
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
import { useState, useCallback, useRef, useEffect } from "react";
import { ensureBackfillWorker, enqueueBackfillStep, readBackfillRun, setStopRequest, writeBackfillRun } from "../services/backfillQueue.server";
import { newRun, resumedRun, type BackfillRun } from "../utils/backfillRun";

/** 裏の取り込みがこの時間動いていなければ、止まったとみなして「続きから再開」を出す */
const STALE_MS = 10 * 60 * 1000;

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const locations = await prisma.location.findMany({
    where: { shopId: shop.id },
    select: { shopifyLocationGid: true, name: true },
    orderBy: { name: "asc" },
  });
  const queueAvailable = (await ensureBackfillWorker()) !== null;
  const run = queueAvailable ? await readBackfillRun(shop.id) : null;
  return { locations, memberCardEnabled: isInhouseMode(), queueAvailable, run, now: new Date().toISOString() };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const now = new Date().toISOString();
  const current = await readBackfillRun(shop.id);
  const stale = current?.state === "running" && Date.now() - Date.parse(current.updatedAt) > STALE_MS;

  if (intent === "stop") {
    if (!current || current.state !== "running") return { ok: true };
    await setStopRequest(shop.id, current.runId);
    await writeBackfillRun(shop.id, { ...current, state: "stopped", updatedAt: now });
    return { ok: true };
  }

  let run: BackfillRun;
  if (intent === "start") {
    if (current?.state === "running" && !stale) {
      return { ok: false, error: "ほかの取り込みが動いています。止めてから始めてください。" };
    }
    const locationId = String(form.get("locationId") ?? "");
    const month = String(form.get("month") ?? "");
    const loc = await prisma.location.findFirst({
      where: { shopId: shop.id, shopifyLocationGid: locationId },
      select: { shopifyLocationGid: true, name: true },
    });
    if (!loc || !/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: "ロケーションと対象月を選んでください。" };
    run = newRun({
      runId: crypto.randomUUID(),
      locationId: loc.shopifyLocationGid,
      locationName: loc.name ?? "",
      month,
      today: now.slice(0, 10),
      now,
    });
  } else if (intent === "resume") {
    if (!current || (current.state === "running" && !stale)) return { ok: true };
    run = resumedRun(current, now);
  } else {
    return { ok: false, error: "操作が分かりません。" };
  }

  await setStopRequest(shop.id, null);
  await writeBackfillRun(shop.id, run);
  const queued = await enqueueBackfillStep({ shopDomain: session.shop, shopId: shop.id, runId: run.runId });
  if (!queued) {
    await writeBackfillRun(shop.id, { ...run, state: "stopped", updatedAt: now });
    return { ok: false, error: "裏で進める仕組みが今使えません。しばらくしてからもう一度お試しください。" };
  }
  return { ok: true };
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
  const { locations, memberCardEnabled, queueAvailable, run, now } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const location = useLocation();

  const monthOptions = buildMonthOptions();
  const locationOptions = locations.map((l) => ({
    label: l.name,
    value: l.shopifyLocationGid,
  }));

  const [selectedLocation, setSelectedLocation] = useState(locationOptions[0]?.value ?? "");
  const [selectedMonth, setSelectedMonth] = useState(monthOptions[0]?.value ?? "");
  // キューが使えないときだけ使う、画面から 1 日ずつ送る取り込みの状態
  const [localRunning, setRunning] = useState(false);
  const [localDayResults, setDayResults] = useState<DayResult[]>([]);
  const [localError, setError] = useState("");
  const abortRef = useRef(false);

  // 裏の取り込み（キュー）の状態。止まったまま 10 分動いていなければ「続きから再開」を出す
  const stale = Boolean(run && run.state === "running" && Date.parse(now) - Date.parse(run.updatedAt) > STALE_MS);
  const running = queueAvailable ? Boolean(run && run.state === "running" && !stale) : localRunning;
  const dayResults: DayResult[] = queueAvailable ? (run?.days ?? []) : localDayResults;
  const error = queueAvailable ? (fetcher.data?.ok === false ? fetcher.data.error ?? "" : "") : localError;
  const busy = fetcher.state !== "idle";
  // この画面で動いているのを見ていた取り込みが終わったときだけ「取込完了」のトーストを出す（開き直すたびに出さない）
  const [watchedRunning, setWatchedRunning] = useState(false);
  useEffect(() => {
    if (running) setWatchedRunning(true);
  }, [running]);

  // 裏で動いている間は、数秒ごとに進み具合を読み直す（画面を開いている間の自動更新）
  useEffect(() => {
    if (!queueAvailable || !running) return;
    const timer = window.setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [queueAvailable, running, revalidator]);

  const processed = dayResults.filter((r) => r.status === "done" || r.status === "skipped" || r.status === "error").length;
  const total = dayResults.length;
  const progress = total > 0 ? Math.round((processed / total) * 100) : 0;
  const done = total > 0 && processed === total;
  const errorCount = dayResults.filter((r) => r.status === "error").length;
  const stopped = !running && total > 0 && !done;
  // 続きから再開できる取り込み（止めた・失敗した日がある・裏で止まったまま）
  const resumable = stopped || errorCount > 0 || stale;
  // 状態はバッジで 1 行に出す（処理中・完了・停止中・要確認。UI ルール v1.1 12章）
  const runState: { label: string; tone?: "info" | "success" | "warning" } = running
    ? { label: "処理中", tone: "info" }
    : stale
    ? { label: "要確認", tone: "warning" }
    : stopped
    ? { label: "停止中" }
    : errorCount > 0
    ? { label: "要確認", tone: "warning" }
    : { label: "完了", tone: "success" };

  const handleLocalStart = useCallback(async () => {
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

  const handleLocalStop = useCallback(() => {
    abortRef.current = true;
  }, []);

  const handleStart = () => {
    if (!queueAvailable) return void handleLocalStart();
    // 前の取り込みが止まっている・失敗した日があるときは続きから（取込済みの日は飛ばす）
    if (run && (stopped || errorCount > 0 || stale)) {
      fetcher.submit({ intent: "resume" }, { method: "post" });
      return;
    }
    fetcher.submit({ intent: "start", locationId: selectedLocation, month: selectedMonth }, { method: "post" });
  };
  const handleNewStart = () => {
    fetcher.submit({ intent: "start", locationId: selectedLocation, month: selectedMonth }, { method: "post" });
  };
  const handleStop = () => {
    if (!queueAvailable) return handleLocalStop();
    fetcher.submit({ intent: "stop" }, { method: "post" });
  };

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
                {queueAvailable
                  ? "選んだ月の売上サマリーの集計を、1日ずつ取り込みます。画面を閉じても裏で続き、取込済みの日は飛ばします。止めたあとは「続きから再開」で残りの日を進めます。"
                  : "選んだ月の売上サマリーの集計を、1日ずつ取り込みます。取込済みの日は飛ばすので、止めたあとは「続きから再開」で残りの日を進めます。画面を閉じると止まります。"}
              </p>
            </AdminIntro>
            {/* 終わったらトーストで知らせる（成功は画面に残さない。UI ルール v1.1 5章） */}
            <SuccessToast message={done && errorCount === 0 && (!queueAvailable || watchedRunning) ? "取込完了しました" : null} trigger={queueAvailable ? run?.runId : localDayResults} />
            {/* 止まった・失敗した日があるときは、お知らせ枠 1 つに理由を出す（UI ルール v1.1 5章・12章） */}
            {stale && errorCount === 0 && (
              <Box paddingBlockStart="300">
                <Banner tone="warning">
                  <Text as="p">裏の取り込みが 10 分以上進んでいません。「続きから再開」で止まった日から続けます。</Text>
                </Banner>
              </Box>
            )}
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
                        <>
                          <Button variant="primary" onClick={handleStart} loading={busy} disabled={!selectedLocation || !selectedMonth}>
                            {resumable ? "続きから再開" : "取込開始"}
                          </Button>
                          {/* 前の取り込みを続けずに、選んだロケーション・月で始める（白いボタン。UI ルール v1.1 12章） */}
                          {queueAvailable && resumable && (
                            <Button onClick={handleNewStart} disabled={busy || !selectedLocation || !selectedMonth}>
                              選んだ月で最初から取り込む
                            </Button>
                          )}
                        </>
                      ) : (
                        <Button onClick={handleStop} loading={busy}>
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
                  {queueAvailable && run && (
                    <Text as="p" tone="subdued">{run.locationName || "（名前なし）"}・{run.month.replace("-", "年")}月</Text>
                  )}
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
