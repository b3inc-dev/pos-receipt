/**
 * /app/budget-management/daily — 予算を日別一覧で入力する
 * 店舗と月を選ぶと 1 日〜月末が並び、まとめて手入力して 1 回で保存する。
 * 保存先は今までと同じ Budget（店舗・日付ごと）。CSV 取り込み・1 件ずつの追加はそのまま使える。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useLocation, useNavigate, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  BlockStack,
  InlineStack,
  InlineGrid,
  Select,
  Banner,
  Button,
  Box,
} from "@shopify/polaris";
import { useMemo, useRef, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getFullAccess, checkPlanAccess } from "../utils/planFeatures.server";
import { getCalendarDateStringInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import { expandLocationIdsForBudgetQuery } from "../utils/salesSummaryBudgetFromDb.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import {
  SaveBar,
  SuccessToast,
  EditTable,
  EditRow,
  EditCell,
  UnitInput,
  confirmLeave,
  markFormDirty,
} from "../components/admin-ui";
import {
  budgetToInput,
  diffBudgetMonth,
  isMonthKey,
  monthChoices,
  monthDays,
  monthLabel,
  parseBudgetInput,
  shortDateLabel,
  sumBudgetMonth,
  type BudgetChange,
} from "../utils/budgetMonthGrid";

const LOCATIONS_QUERY = `#graphql
  query Locations {
    locations(first: 50, includeLegacy: false) {
      nodes { id name isActive }
    }
  }
`;

const AMOUNT_PREFIX = "amount.";

type ActionResult =
  | { ok: true; saved: number }
  | { ok: false; error: string; rowErrors?: Record<string, string> };

function toLocationGid(id: string) {
  return id.startsWith("gid://") ? id : `gid://shopify/Location/${id}`;
}

function fmtYen(n: number) {
  return `¥${n.toLocaleString("ja-JP")}`;
}

function fmtBudget(n: number | null) {
  return n === null ? "なし" : fmtYen(n);
}

/** 店舗・月の保存済みの予算（date → 金額）。数字だけの店舗 ID で入った古い行も読む（GID の行を優先） */
async function loadMonthBudgets(shopId: string, locationGid: string, monthKey: string) {
  const days = monthDays(monthKey);
  if (days.length === 0) return {} as Record<string, number>;
  const variants = expandLocationIdsForBudgetQuery(locationGid);
  const rows = await prisma.budget.findMany({
    where: {
      shopId,
      locationId: { in: variants },
      targetDate: { gte: days[0].date, lte: days[days.length - 1].date },
    },
    select: { locationId: true, targetDate: true, amount: true },
  });
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.locationId === locationGid || out[r.targetDate] === undefined) {
      out[r.targetDate] = Number(r.amount);
    }
  }
  return out;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const locRes = await admin.graphql(LOCATIONS_QUERY);
  const locJson = (await locRes.json()) as {
    data?: { locations?: { nodes?: { id: string; name: string; isActive: boolean }[] } };
  };
  const locations = (locJson.data?.locations?.nodes ?? []).filter((l) => l.isActive);

  const fullAccess = await getFullAccess(admin, session);
  const access = checkPlanAccess(shop.planCode, "budget_management", fullAccess);

  // 「今月」は店舗の時間帯（日本の店は日本時間）で決める
  const timezone = await getShopTimezoneForDaily(admin, shop.id);
  const today = getCalendarDateStringInTimeZone(new Date(), timezone);
  const thisMonth = today.slice(0, 7);

  const url = new URL(request.url);
  const monthParam = url.searchParams.get("month") ?? "";
  const month = isMonthKey(monthParam) ? monthParam : thisMonth;
  const locationParam = url.searchParams.get("locationId") ?? "";
  const location =
    locations.find((l) => l.id === locationParam || l.id === toLocationGid(locationParam)) ?? locations[0] ?? null;

  const saved = location ? await loadMonthBudgets(shop.id, location.id, month) : {};

  return {
    locations: locations.map((l) => ({ id: l.id, name: l.name })),
    locationId: location?.id ?? "",
    locationName: location?.name ?? "",
    month,
    thisMonth,
    today,
    days: monthDays(month),
    saved,
    hasAccess: access.allowed,
    planMessage: access.message,
  };
}

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const fullAccess = await getFullAccess(admin, session);
  const access = checkPlanAccess(shop.planCode, "budget_management", fullAccess);
  if (!access.allowed) {
    return Response.json({ ok: false, error: access.message } satisfies ActionResult, { status: 403 });
  }

  const formData = await request.formData();
  const locationIdRaw = String(formData.get("locationId") ?? "");
  const month = String(formData.get("month") ?? "");
  if (!locationIdRaw || !isMonthKey(month)) {
    return Response.json({ ok: false, error: "店舗と月が選ばれていません。画面を開き直してください。" } satisfies ActionResult, { status: 400 });
  }
  const locationGid = toLocationGid(locationIdRaw);
  const days = monthDays(month).map((d) => d.date);

  // 開いた時点の値（画面に出していた保存済みの値）
  let baseline: Record<string, number | null> = {};
  try {
    baseline = JSON.parse(String(formData.get("baseline") ?? "{}")) as Record<string, number | null>;
  } catch {
    return Response.json({ ok: false, error: "画面の情報を読めませんでした。画面を開き直してください。" } satisfies ActionResult, { status: 400 });
  }

  // この月の日でない欄が来たら保存しない（入力を黙って捨てない）
  const inputs: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith(AMOUNT_PREFIX)) continue;
    const date = key.slice(AMOUNT_PREFIX.length);
    if (!days.includes(date)) {
      return Response.json({ ok: false, error: `${monthLabel(month)}でない日付（${date}）が送られてきました。画面を開き直してください。` } satisfies ActionResult, { status: 400 });
    }
    inputs[date] = String(value);
  }

  const { changes, errors } = diffBudgetMonth(days, baseline, inputs);
  if (errors.length > 0) {
    const rowErrors = Object.fromEntries(errors.map((e) => [e.date, e.reason]));
    const list = errors.map((e) => shortDateLabel(e.date)).join("・");
    return Response.json({ ok: false, error: `${list} の金額を直してください。何も保存していません。`, rowErrors } satisfies ActionResult, { status: 400 });
  }
  if (changes.length === 0) {
    return Response.json({ ok: true, saved: 0 } satisfies ActionResult);
  }

  // 開いたあとに CSV やほかの画面で変わった日は、上書きせずに止める
  const current = await loadMonthBudgets(shop.id, locationGid, month);
  const conflicted = changes.filter((c) => (current[c.date] ?? null) !== (baseline[c.date] ?? null));
  if (conflicted.length > 0) {
    const list = conflicted.map((c) => shortDateLabel(c.date)).join("・");
    return Response.json({
      ok: false,
      error: `${list} の予算は、この画面を開いたあとに別の所で変わりました。何も保存していません。画面を開き直してから入力してください。`,
    } satisfies ActionResult, { status: 409 });
  }

  const variants = expandLocationIdsForBudgetQuery(locationGid);
  const legacyIds = variants.filter((v) => v !== locationGid);
  const changedDates = changes.map((c) => c.date);

  await prisma.$transaction(async (tx) => {
    // 数字だけの店舗 ID で入った古い行は、同じ日を書き直すときに GID の行へまとめる（二重に数えない）
    if (legacyIds.length > 0) {
      await tx.budget.deleteMany({
        where: { shopId: shop.id, locationId: { in: legacyIds }, targetDate: { in: changedDates } },
      });
    }
    for (const c of changes) {
      const where = { shopId_locationId_targetDate: { shopId: shop.id, locationId: locationGid, targetDate: c.date } };
      if (c.after === null) {
        await tx.budget.deleteMany({ where: { shopId: shop.id, locationId: locationGid, targetDate: c.date } });
      } else {
        await tx.budget.upsert({
          where,
          update: { amount: c.after },
          create: { shopId: shop.id, locationId: locationGid, targetDate: c.date, amount: c.after },
        });
      }
    }
    // 売上サマリーの日次の控え（予算・予算比）も同じ値にする（POS の予算登録と同じ）
    const cached = await tx.salesSummaryCacheDaily.findMany({
      where: { shopId: shop.id, locationId: locationGid, targetDate: { in: changedDates } },
      select: { id: true, targetDate: true, actual: true },
    });
    const afterByDate = new Map(changes.map((c) => [c.date, c.after]));
    for (const row of cached) {
      const budget = afterByDate.get(row.targetDate) ?? null;
      const actual = Number(row.actual);
      await tx.salesSummaryCacheDaily.update({
        where: { id: row.id },
        data: { budget, budgetRatio: budget && budget > 0 ? actual / budget : null },
      });
    }
  });

  return Response.json({ ok: true, saved: changes.length } satisfies ActionResult);
}

function changeBadge(change: BudgetChange | undefined) {
  if (!change) return null;
  if (change.kind === "add") return <Badge tone="info">追加</Badge>;
  if (change.kind === "remove") return <Badge tone="warning">削除</Badge>;
  return <Badge tone="info">変更</Badge>;
}

export default function BudgetDailyPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionResult>();
  const navigate = useNavigate();
  const location = useLocation();

  const go = (next: { locationId?: string; month?: string }) => {
    const params = new URLSearchParams(location.search);
    params.set("locationId", next.locationId ?? data.locationId);
    params.set("month", next.month ?? data.month);
    void confirmLeave().then(() => navigate(`${location.pathname}?${params.toString()}`));
  };
  const back = () => {
    // 予算管理の一覧は、いま見ている店舗・月で絞り込んで開く
    const params = new URLSearchParams(location.search);
    params.set("locationId", data.locationId);
    params.set("month", data.month);
    void confirmLeave().then(() => navigate(`/app/budget-management?${params.toString()}`));
  };

  const monthOptions = monthChoices(data.thisMonth).map((m) => ({
    label: m === data.thisMonth ? `${monthLabel(m)}（今月）` : monthLabel(m),
    value: m,
  }));
  if (!monthOptions.some((o) => o.value === data.month)) {
    monthOptions.unshift({ label: monthLabel(data.month), value: data.month });
  }

  // 保存のあと（読み直した値が変わったとき）に入力を作り直す
  const formKey = `${data.locationId}|${data.month}|${JSON.stringify(data.saved)}`;

  return (
    <PolarisPageWrapper>
      <Page
        title="予算を日別に入力"
        subtitle="店舗と月を選ぶと、その月の毎日の予算を一覧で入力できます。"
        backAction={{ content: "予算管理", onAction: back }}
      >
        <SuccessToast message={actionData?.ok ? "保存しました" : null} trigger={actionData} />
        <Layout>
          {!data.hasAccess && (
            <Layout.Section>
              <Banner tone="warning">
                <Text as="p">{data.planMessage}</Text>
              </Banner>
            </Layout.Section>
          )}
          {data.hasAccess && actionData && !actionData.ok && (
            <Layout.Section>
              <Banner tone="critical" title="保存できませんでした">
                <Text as="p">{actionData.error}</Text>
              </Banner>
            </Layout.Section>
          )}

          <Layout.Section>
            <Card>
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                <Select
                  label="店舗"
                  options={data.locations.map((l) => ({ label: l.name, value: l.id }))}
                  value={data.locationId}
                  onChange={(v) => go({ locationId: v })}
                  disabled={data.locations.length === 0}
                />
                <Select
                  label="月"
                  options={monthOptions}
                  value={data.month}
                  onChange={(v) => go({ month: v })}
                />
              </InlineGrid>
            </Card>
          </Layout.Section>

          {data.locations.length === 0 ? (
            <Layout.Section>
              <Card>
                <Text as="p" tone="subdued">使える店舗がありません。Shopify の設定でロケーションを有効にしてください。</Text>
              </Card>
            </Layout.Section>
          ) : (
            <DailyBudgetForm
              key={formKey}
              data={data}
              rowErrors={actionData && !actionData.ok ? actionData.rowErrors : undefined}
              failed={Boolean(actionData && !actionData.ok)}
            />
          )}
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}

function DailyBudgetForm({
  data,
  rowErrors,
  failed,
}: {
  data: ReturnType<typeof useLoaderData<typeof loader>>;
  rowErrors?: Record<string, string>;
  failed: boolean;
}) {
  const navigation = useNavigation();
  const formRef = useRef<HTMLFormElement | null>(null);
  const initialInputs = useMemo(
    () => Object.fromEntries(data.days.map((d) => [d.date, budgetToInput(data.saved[d.date])])),
    [data.days, data.saved],
  );
  const [inputs, setInputs] = useState<Record<string, string>>(initialInputs);
  const [fillAmount, setFillAmount] = useState("");
  const dates = data.days.map((d) => d.date);

  const { changes, errors } = diffBudgetMonth(dates, data.saved, inputs);
  const changeByDate = new Map(changes.map((c) => [c.date, c]));
  const errorByDate = new Map(errors.map((e) => [e.date, e.reason]));
  const savedSum = sumBudgetMonth(dates.map((d) => data.saved[d]));
  const nowSum = sumBudgetMonth(
    dates.map((d) => {
      const parsed = parseBudgetInput(inputs[d] ?? "");
      return parsed.ok ? parsed.value : data.saved[d];
    }),
  );
  const fill = parseBudgetInput(fillAmount);
  const emptyDays = dates.filter((d) => (inputs[d] ?? "").trim() === "").length;
  const readOnly = !data.hasAccess;
  const saving = navigation.state === "submitting";

  const setDay = (date: string, value: string) => setInputs((prev) => ({ ...prev, [date]: value }));
  const fillEmptyDays = () => {
    if (!fill.ok || fill.value === null) return;
    const value = String(fill.value);
    setInputs((prev) => {
      const next = { ...prev };
      for (const d of dates) if ((next[d] ?? "").trim() === "") next[d] = value;
      return next;
    });
    // 欄を JS で書き換えたので、保存の帯に知らせる
    window.setTimeout(() => markFormDirty(formRef.current), 0);
  };

  return (
    <>
      <Layout.Section>
        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center" wrap>
              <Text as="h2" variant="headingMd">{data.locationName}・{monthLabel(data.month)}の合計</Text>
              <Text as="p" variant="headingLg" numeric>{fmtYen(nowSum.total)}</Text>
            </InlineStack>
            <Text as="p" tone="subdued">
              予算が入っている日: {nowSum.filledDays} / {dates.length} 日
              {changes.length > 0 ? `。保存済みの合計は ${fmtYen(savedSum.total)} です（${changes.length} 日を変更中・まだ保存していません）。` : "。"}
            </Text>
            {errors.length > 0 && (
              <Text as="p" tone="critical">
                {errors.map((e) => shortDateLabel(e.date)).join("・")} の金額を直してください。直すまで保存できません（合計には保存済みの値を入れています）。
              </Text>
            )}
          </BlockStack>
        </Card>
      </Layout.Section>

      {changes.length > 0 && (
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingSm">保存前の変更（{changes.length} 日）</Text>
              <BlockStack gap="100">
                {changes.map((c) => {
                  const day = data.days.find((d) => d.date === c.date);
                  return (
                    <InlineStack key={c.date} gap="200" blockAlign="center" wrap={false}>
                      <Box minWidth="72px"><Text as="span">{shortDateLabel(c.date)}（{day?.weekdayLabel}）</Text></Box>
                      <Text as="span" numeric>{fmtBudget(c.before)} → {fmtBudget(c.after)}</Text>
                    </InlineStack>
                  );
                })}
              </BlockStack>
              <Text as="p" variant="bodySm" tone="subdued">上の帯の「保存」でまとめて保存します。「破棄」で元に戻ります。</Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      )}

      <Layout.Section>
        <Card>
          <BlockStack gap="300">
            {!readOnly && (
              <InlineStack gap="200" blockAlign="end" wrap>
                <Box minWidth="200px">
                  <div className="Admin-form">
                    <Text as="p" variant="bodySm">空欄の日にまとめて入れる金額</Text>
                    <UnitInput
                      label="空欄の日にまとめて入れる金額"
                      unit="円"
                      inputMode="numeric"
                      value={fillAmount}
                      onChange={(e) => setFillAmount(e.currentTarget.value)}
                    />
                  </div>
                </Box>
                <Button onClick={fillEmptyDays} disabled={!fill.ok || fill.value === null || emptyDays === 0}>
                  {`空欄の ${emptyDays} 日に入れる`}
                </Button>
              </InlineStack>
            )}

            <Form method="post" ref={formRef} className="Admin-form">
              <input type="hidden" name="locationId" value={data.locationId} />
              <input type="hidden" name="month" value={data.month} />
              <input type="hidden" name="baseline" value={JSON.stringify(data.saved)} />
              {!readOnly && <SaveBar failed={failed && !saving} onDiscard={() => setInputs(initialInputs)} />}
              <EditTable
                columns={[
                  { label: "日付", width: "minmax(88px, 1fr)" },
                  { label: "予算", width: "minmax(140px, 2fr)" },
                  { label: "", width: "minmax(56px, 1fr)" },
                ]}
              >
                {data.days.map((d) => {
                  const error = errorByDate.get(d.date) ?? rowErrors?.[d.date];
                  const weekend = d.weekday === 0 || d.weekday === 6;
                  return (
                    <EditRow key={d.date}>
                      <EditCell label="">
                        <Text as="span" fontWeight={d.date === data.today ? "bold" : "regular"} tone={weekend ? "subdued" : undefined}>
                          {shortDateLabel(d.date)}（{d.weekdayLabel}）{d.date === data.today ? " 今日" : ""}
                        </Text>
                      </EditCell>
                      <EditCell label="">
                        <UnitInput
                          label={`${shortDateLabel(d.date)}（${d.weekdayLabel}）の予算`}
                          unit="円"
                          name={`${AMOUNT_PREFIX}${d.date}`}
                          inputMode="numeric"
                          autoComplete="off"
                          value={inputs[d.date] ?? ""}
                          onChange={(e) => setDay(d.date, e.currentTarget.value)}
                          readOnly={readOnly}
                          aria-invalid={error ? true : undefined}
                        />
                        {error ? (
                          <Text as="p" variant="bodySm" tone="critical">
                            <span role="alert">{error}</span>
                          </Text>
                        ) : null}
                      </EditCell>
                      <EditCell label="" end>
                        {changeBadge(changeByDate.get(d.date))}
                      </EditCell>
                    </EditRow>
                  );
                })}
              </EditTable>
            </Form>
            <Text as="p" variant="bodySm" tone="subdued">
              空欄の日は予算なしになります。保存済みの日を空欄にして保存すると、その日の予算を消します。
            </Text>
          </BlockStack>
        </Card>
      </Layout.Section>
    </>
  );
}
