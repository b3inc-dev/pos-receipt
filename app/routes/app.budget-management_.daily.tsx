/**
 * /app/budget-management/daily — 予算を日別一覧で入力する
 * 店舗（複数可）と月を選ぶと、行が 1 日〜月末、列が店の表になり、まとめて手入力して 1 回で保存する。
 * スマホ幅では 1 店ずつ表示する（選んだ店は上の切り替えで移る）。
 * 保存先は今までと同じ Budget（店舗・日付ごと）。CSV 取り込み・1 件ずつの追加はそのまま使える。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useLocation, useNavigate, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Select,
  Banner,
  Button,
  Checkbox,
} from "@shopify/polaris";
import { useEffect, useMemo, useRef, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getFullAccess, checkPlanAccess } from "../utils/planFeatures.server";
import { getCalendarDateStringInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import { expandLocationIdsForBudgetQuery } from "../utils/salesSummaryBudgetFromDb.server";
import { applyBudgetDayChanges } from "../services/budgetWrite.server";
import { getCiaraSyncedLocationIds } from "../services/ciaraBudgetSync.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { SaveBar, SuccessToast, UnitInput, confirmLeave, markFormDirty } from "../components/admin-ui";
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

/** 入力欄の名前: amount.<ロケーションの数字の ID>.<YYYY-MM-DD> */
const AMOUNT_PREFIX = "amount.";
/** 変更の一覧に一度に出す件数 */
const CHANGE_LIST_LIMIT = 30;

type ActionResult =
  | { ok: true; saved: number }
  | { ok: false; error: string; rowErrors?: Record<string, Record<string, string>> };

type SavedByLocation = Record<string, Record<string, number>>;

function toLocationGid(id: string) {
  return id.startsWith("gid://") ? id : `gid://shopify/Location/${id}`;
}
function numericLocationId(gid: string) {
  return gid.replace("gid://shopify/Location/", "");
}

function fmtYen(n: number) {
  return `¥${n.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}`;
}
function fmtBudget(n: number | null) {
  return n === null ? "なし" : fmtYen(n);
}

/** URL の店舗の指定（locationIds=1,2 か、前の形の locationId=…）を並べる */
function parseLocationParam(url: URL): string[] {
  const raw = url.searchParams.get("locationIds") ?? url.searchParams.get("locationId") ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map(toLocationGid);
}

/** 店舗ごと・月の保存済みの予算。数字だけの店舗 ID で入った古い行も読む（GID の行を優先） */
async function loadMonthBudgets(shopId: string, locationGids: string[], monthKey: string): Promise<SavedByLocation> {
  const days = monthDays(monthKey);
  const out: SavedByLocation = Object.fromEntries(locationGids.map((g) => [g, {}]));
  if (days.length === 0 || locationGids.length === 0) return out;
  const variantToGid = new Map<string, string>();
  for (const g of locationGids) for (const v of expandLocationIdsForBudgetQuery(g)) variantToGid.set(v, g);
  const rows = await prisma.budget.findMany({
    where: {
      shopId,
      locationId: { in: [...variantToGid.keys()] },
      targetDate: { gte: days[0].date, lte: days[days.length - 1].date },
    },
    select: { locationId: true, targetDate: true, amount: true },
  });
  for (const r of rows) {
    const gid = variantToGid.get(r.locationId);
    if (!gid) continue;
    if (r.locationId === gid || out[gid][r.targetDate] === undefined) {
      out[gid][r.targetDate] = Number(r.amount);
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
  // 店舗の並びは Shopify のロケーションの順にそろえる
  const wanted = new Set(parseLocationParam(url));
  let selected = locations.filter((l) => wanted.has(l.id));
  if (selected.length === 0 && locations[0]) selected = [locations[0]];

  const saved = await loadMonthBudgets(shop.id, selected.map((l) => l.id), month);
  // ciara-system から取り込む店（Ciara のカスタムアプリで取り込みがオンのときだけ）は見るだけ
  const syncedLocationIds = await getCiaraSyncedLocationIds(shop.id);

  return {
    syncedLocationIds,
    locations: locations.map((l) => ({ id: l.id, name: l.name })),
    selected: selected.map((l) => ({ id: l.id, name: l.name })),
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
  const month = String(formData.get("month") ?? "");
  const locationGids = String(formData.get("locationIds") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean).map(toLocationGid);
  if (locationGids.length === 0 || !isMonthKey(month)) {
    return Response.json({ ok: false, error: "店舗と月が選ばれていません。画面を開き直してください。" } satisfies ActionResult, { status: 400 });
  }
  const days = monthDays(month).map((d) => d.date);
  const byNumeric = new Map(locationGids.map((g) => [numericLocationId(g), g]));

  // 開いた時点の値（画面に出していた保存済みの値）
  let baseline: SavedByLocation = {};
  try {
    baseline = JSON.parse(String(formData.get("baseline") ?? "{}")) as SavedByLocation;
  } catch {
    return Response.json({ ok: false, error: "画面の情報を読めませんでした。画面を開き直してください。" } satisfies ActionResult, { status: 400 });
  }

  // 選んだ店・この月の日でない欄が来たら保存しない（入力を黙って捨てない）
  const inputs: Record<string, Record<string, string>> = Object.fromEntries(locationGids.map((g) => [g, {}]));
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith(AMOUNT_PREFIX)) continue;
    const [numeric, date] = key.slice(AMOUNT_PREFIX.length).split(".");
    const gid = byNumeric.get(numeric ?? "");
    if (!gid || !date || !days.includes(date)) {
      return Response.json({ ok: false, error: "選んだ店・月でない入力が送られてきました。画面を開き直してください。" } satisfies ActionResult, { status: 400 });
    }
    inputs[gid][date] = String(value);
  }

  const changesByGid = new Map<string, BudgetChange[]>();
  const rowErrors: Record<string, Record<string, string>> = {};
  const errorLabels: string[] = [];
  for (const gid of locationGids) {
    const { changes, errors } = diffBudgetMonth(days, baseline[gid] ?? {}, inputs[gid]);
    if (changes.length > 0) changesByGid.set(gid, changes);
    if (errors.length > 0) {
      rowErrors[gid] = Object.fromEntries(errors.map((e) => [e.date, e.reason]));
      errorLabels.push(...errors.map((e) => shortDateLabel(e.date)));
    }
  }
  if (errorLabels.length > 0) {
    return Response.json({
      ok: false,
      error: `${[...new Set(errorLabels)].join("・")} の金額を直してください。何も保存していません。`,
      rowErrors,
    } satisfies ActionResult, { status: 400 });
  }
  const synced = new Set(await getCiaraSyncedLocationIds(shop.id));
  if ([...changesByGid.keys()].some((g) => synced.has(g))) {
    return Response.json({
      ok: false,
      error: "ciara-system から取り込んでいる店の予算は、ここでは変えられません。ciara-system で入力してください。何も保存していません。",
    } satisfies ActionResult, { status: 400 });
  }
  const total = [...changesByGid.values()].reduce((n, c) => n + c.length, 0);
  if (total === 0) {
    return Response.json({ ok: true, saved: 0 } satisfies ActionResult);
  }

  // 開いたあとに CSV やほかの画面で変わった日は、上書きせずに止める
  const current = await loadMonthBudgets(shop.id, [...changesByGid.keys()], month);
  const conflicted: string[] = [];
  for (const [gid, changes] of changesByGid) {
    for (const c of changes) {
      if ((current[gid]?.[c.date] ?? null) !== (baseline[gid]?.[c.date] ?? null)) conflicted.push(shortDateLabel(c.date));
    }
  }
  if (conflicted.length > 0) {
    return Response.json({
      ok: false,
      error: `${[...new Set(conflicted)].join("・")} の予算は、この画面を開いたあとに別の所で変わりました。何も保存していません。画面を開き直してから入力してください。`,
    } satisfies ActionResult, { status: 409 });
  }

  await prisma.$transaction(async (tx) => {
    for (const [gid, changes] of changesByGid) {
      await applyBudgetDayChanges(tx, shop.id, gid, changes);
    }
  });

  return Response.json({ ok: true, saved: total } satisfies ActionResult);
}

export default function BudgetDailyPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionResult>();
  const navigate = useNavigate();
  const location = useLocation();
  const selectedIds = data.selected.map((l) => l.id);

  const go = (next: { locationIds?: string[]; month?: string }) => {
    const params = new URLSearchParams(location.search);
    params.delete("locationId");
    params.set("locationIds", (next.locationIds ?? selectedIds).map(numericLocationId).join(","));
    params.set("month", next.month ?? data.month);
    void confirmLeave().then(() => navigate(`${location.pathname}?${params.toString()}`));
  };
  const back = () => {
    // 予算管理の一覧は、いま見ている月（1 店のときはその店）で絞り込んで開く
    const params = new URLSearchParams(location.search);
    params.delete("locationIds");
    if (selectedIds.length === 1) params.set("locationId", selectedIds[0]);
    else params.delete("locationId");
    params.set("month", data.month);
    void confirmLeave().then(() => navigate(`/app/budget-management?${params.toString()}`));
  };
  const toggleStore = (id: string) => {
    const next = selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
    if (next.length === 0) return; // 1 店は残す
    go({ locationIds: data.locations.filter((l) => next.includes(l.id)).map((l) => l.id) });
  };
  const allSelected = selectedIds.length === data.locations.length;

  const monthOptions = monthChoices(data.thisMonth).map((m) => ({
    label: m === data.thisMonth ? `${monthLabel(m)}（今月）` : monthLabel(m),
    value: m,
  }));
  if (!monthOptions.some((o) => o.value === data.month)) {
    monthOptions.unshift({ label: monthLabel(data.month), value: data.month });
  }

  // 保存のあと（読み直した値が変わったとき）に入力を作り直す
  const formKey = `${selectedIds.join(",")}|${data.month}|${JSON.stringify(data.saved)}`;

  return (
    <PolarisPageWrapper>
      <Page
        title="予算を日別に入力"
        fullWidth
        subtitle="店舗と月を選ぶと、その月の毎日の予算を一覧で入力できます。店舗は複数選べます。"
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
              <BlockStack gap="300">
                <div style={{ maxWidth: 320 }}>
                  <Select label="月" options={monthOptions} value={data.month} onChange={(v) => go({ month: v })} />
                </div>
                {data.locations.length > 0 && (
                  <BlockStack gap="100">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" variant="bodyMd">店舗（{selectedIds.length} / {data.locations.length}）</Text>
                      <Button
                        size="slim"
                        onClick={() => go({ locationIds: allSelected ? [data.locations[0].id] : data.locations.map((l) => l.id) })}
                      >
                        {allSelected ? "1 店に戻す" : "すべて選ぶ"}
                      </Button>
                    </InlineStack>
                    <div className="BudgetDaily-stores">
                      {data.locations.map((l) => (
                        <Checkbox
                          key={l.id}
                          label={l.name}
                          checked={selectedIds.includes(l.id)}
                          disabled={selectedIds.length === 1 && selectedIds[0] === l.id}
                          onChange={() => toggleStore(l.id)}
                        />
                      ))}
                    </div>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          {data.locations.length === 0 ? (
            <Layout.Section>
              <Card>
                <Text as="p" tone="subdued">使える店舗がありません。Shopify の設定でロケーションを有効にしてください。</Text>
              </Card>
            </Layout.Section>
          ) : (
            <DailyBudgetGrid
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

/** 表の見た目（日付の列は左に固定、店の列は横に送る。スマホ幅は 1 店ずつ） */
const gridCss = `
  .BudgetDaily-stores { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0 12px; }
  .BudgetDaily-scroll { overflow-x: auto; max-width: 100%; }
  .BudgetDaily-table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 13px; table-layout: fixed; }
  .BudgetDaily-table th, .BudgetDaily-table td { padding: 6px 8px; border-bottom: 1px solid #ebebeb; text-align: left; white-space: nowrap; vertical-align: top; }
  .BudgetDaily-table thead th { font-weight: 600; color: #303030; background: #fff; }
  .BudgetDaily-table .BudgetDaily-date { position: sticky; left: 0; background: #fff; z-index: 1; width: 104px; }
  .BudgetDaily-table .BudgetDaily-col { width: 180px; }
  .BudgetDaily-table .BudgetDaily-num { text-align: right; font-variant-numeric: tabular-nums; }
  .BudgetDaily-table tr.is-total td, .BudgetDaily-table tr.is-total th { background: #f7f7f7; font-weight: 600; }
  .BudgetDaily-table tr.is-today th { font-weight: 700; }
  .BudgetDaily-table .is-weekend { color: #616161; }
  .BudgetDaily-table td.is-changed { background: #eaf4ff; }
  .BudgetDaily-table td.is-error { background: #fff4f4; }
  .BudgetDaily-err { color: #8e1f0b; font-size: 12px; margin-top: 2px; white-space: normal; }
  .BudgetDaily-note { font-size: 12px; margin-top: 2px; color: #005bd3; white-space: normal; }
  .BudgetDaily-sub { font-weight: 400; color: #616161; font-size: 12px; }
  .BudgetDaily-fill { display: flex; flex-direction: column; gap: 4px; align-items: stretch; }
  .BudgetDaily-phone-pick { display: none; }
  @media (max-width: 767px) {
    .BudgetDaily-phone-pick { display: block; }
    .BudgetDaily-table .BudgetDaily-col:not(.is-active) { display: none; }
    .BudgetDaily-table .BudgetDaily-col { width: auto; }
  }
`;

function DailyBudgetGrid({
  data,
  rowErrors,
  failed,
}: {
  data: ReturnType<typeof useLoaderData<typeof loader>>;
  rowErrors?: Record<string, Record<string, string>>;
  failed: boolean;
}) {
  const navigation = useNavigation();
  const formRef = useRef<HTMLFormElement | null>(null);
  const stores = data.selected;
  const dates = useMemo(() => data.days.map((d) => d.date), [data.days]);
  const initialInputs = useMemo(
    () =>
      Object.fromEntries(
        stores.map((s) => [s.id, Object.fromEntries(dates.map((d) => [d, budgetToInput(data.saved[s.id]?.[d])]))]),
      ) as Record<string, Record<string, string>>,
    [stores, dates, data.saved],
  );
  const [inputs, setInputs] = useState(initialInputs);
  const [fills, setFills] = useState<Record<string, string>>({});
  const [activeStore, setActiveStore] = useState(stores[0]?.id ?? "");
  useEffect(() => {
    if (!stores.some((s) => s.id === activeStore)) setActiveStore(stores[0]?.id ?? "");
  }, [stores, activeStore]);
  const readOnly = !data.hasAccess;
  const syncedIds = new Set(data.syncedLocationIds);
  const saving = navigation.state === "submitting";

  const perStore = stores.map((s) => {
    const saved = data.saved[s.id] ?? {};
    const { changes, errors } = diffBudgetMonth(dates, saved, inputs[s.id] ?? {});
    const now = sumBudgetMonth(
      dates.map((d) => {
        const parsed = parseBudgetInput(inputs[s.id]?.[d] ?? "");
        return parsed.ok ? parsed.value : saved[d];
      }),
    );
    const before = sumBudgetMonth(dates.map((d) => saved[d]));
    return {
      store: s,
      changes,
      changeByDate: new Map(changes.map((c) => [c.date, c])),
      errorByDate: new Map(errors.map((e) => [e.date, e.reason])),
      errors,
      now,
      before,
      emptyDays: dates.filter((d) => (inputs[s.id]?.[d] ?? "").trim() === "").length,
    };
  });
  const allChanges = perStore.flatMap((p) => p.changes.map((c) => ({ ...c, storeName: p.store.name })));
  const allErrors = perStore.flatMap((p) => p.errors.map((e) => ({ ...e, storeName: p.store.name })));
  const grandNow = perStore.reduce((n, p) => n + p.now.total, 0);
  const grandBefore = perStore.reduce((n, p) => n + p.before.total, 0);
  const weekdayOf = new Map(data.days.map((d) => [d.date, d.weekdayLabel]));
  const multi = stores.length > 1;
  const colClass = (storeId: string, extra = "") =>
    ["BudgetDaily-col", storeId === activeStore ? "is-active" : "", extra].filter(Boolean).join(" ");

  const setDay = (storeId: string, date: string, value: string) =>
    setInputs((prev) => ({ ...prev, [storeId]: { ...prev[storeId], [date]: value } }));
  const fillEmptyDays = (storeId: string) => {
    const fill = parseBudgetInput(fills[storeId] ?? "");
    if (!fill.ok || fill.value === null) return;
    const value = budgetToInput(fill.value);
    setInputs((prev) => {
      const next = { ...prev[storeId] };
      for (const d of dates) if ((next[d] ?? "").trim() === "") next[d] = value;
      return { ...prev, [storeId]: next };
    });
    // 欄を JS で書き換えたので、保存の帯に知らせる
    window.setTimeout(() => markFormDirty(formRef.current), 0);
  };

  return (
    <>
      <style>{gridCss}</style>
      <Layout.Section>
        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center" wrap>
              <Text as="h2" variant="headingMd">
                {monthLabel(data.month)}の合計（{multi ? `${stores.length} 店` : stores[0]?.name ?? ""}）
              </Text>
              <Text as="p" variant="headingLg" numeric>{fmtYen(grandNow)}</Text>
            </InlineStack>
            {allChanges.length > 0 && (
              <Text as="p" tone="subdued">
                保存済みの合計は {fmtYen(grandBefore)} です（{allChanges.length} 件を変更中・まだ保存していません）。
              </Text>
            )}
            {allErrors.length > 0 && (
              <Text as="p" tone="critical">
                {allErrors.slice(0, 10).map((e) => `${multi ? `${e.storeName} ` : ""}${shortDateLabel(e.date)}`).join("・")}
                {allErrors.length > 10 ? ` ほか ${allErrors.length - 10} 件` : ""} の金額を直してください。直すまで保存できません。
              </Text>
            )}
          </BlockStack>
        </Card>
      </Layout.Section>

      {allChanges.length > 0 && (
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingSm">保存前の変更（{allChanges.length} 件）</Text>
              <BlockStack gap="100">
                {allChanges.slice(0, CHANGE_LIST_LIMIT).map((c) => (
                  <Text key={`${c.storeName}-${c.date}`} as="p" numeric>
                    {multi ? `${c.storeName}　` : ""}
                    {shortDateLabel(c.date)}（{weekdayOf.get(c.date)}）　{fmtBudget(c.before)} → {fmtBudget(c.after)}
                  </Text>
                ))}
                {allChanges.length > CHANGE_LIST_LIMIT && (
                  <Text as="p" tone="subdued">ほか {allChanges.length - CHANGE_LIST_LIMIT} 件（表の青い欄）</Text>
                )}
              </BlockStack>
              <Text as="p" variant="bodySm" tone="subdued">上の帯の「保存」でまとめて保存します。「破棄」で元に戻ります。</Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      )}

      <Layout.Section>
        <Card>
          <BlockStack gap="300">
            {multi && (
              <div className="BudgetDaily-phone-pick">
                <Select
                  label="表示する店舗"
                  options={stores.map((s) => ({ label: s.name, value: s.id }))}
                  value={activeStore}
                  onChange={setActiveStore}
                />
              </div>
            )}
            <Form method="post" ref={formRef} className="Admin-form">
              <input type="hidden" name="locationIds" value={stores.map((s) => numericLocationId(s.id)).join(",")} />
              <input type="hidden" name="month" value={data.month} />
              <input type="hidden" name="baseline" value={JSON.stringify(data.saved)} />
              {!readOnly && <SaveBar failed={failed && !saving} onDiscard={() => setInputs(initialInputs)} />}
              <div className="BudgetDaily-scroll">
                <table className="BudgetDaily-table">
                  <thead>
                    <tr>
                      <th className="BudgetDaily-date" scope="col">日付</th>
                      {stores.map((s) => (
                        <th key={s.id} scope="col" className={colClass(s.id, "BudgetDaily-cell")}>
                          {s.name}
                          {syncedIds.has(s.id) ? <div className="BudgetDaily-sub">ciara-system から取り込み（見るだけ）</div> : null}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="is-total">
                      <th className="BudgetDaily-date" scope="row">月の合計</th>
                      {perStore.map((p) => (
                        <td key={p.store.id} className={colClass(p.store.id, "BudgetDaily-num")}>
                          {fmtYen(p.now.total)}
                          <div className="BudgetDaily-sub">
                            {p.now.filledDays} / {dates.length} 日
                            {p.changes.length > 0 ? `・保存済み ${fmtYen(p.before.total)}` : ""}
                          </div>
                        </td>
                      ))}
                    </tr>
                    {!readOnly && (
                      <tr>
                        <th className="BudgetDaily-date BudgetDaily-sub" scope="row" style={{ whiteSpace: "normal" }}>空欄の日に<br />まとめて入れる</th>
                        {perStore.map((p) => {
                          const fill = parseBudgetInput(fills[p.store.id] ?? "");
                          return (
                            <td key={p.store.id} className={colClass(p.store.id, "BudgetDaily-cell")}>
                              <div className="BudgetDaily-fill">
                                {/* 保存するフォームの値に入れない（form をこのフォームから外す） */}
                                <UnitInput
                                  label={`${p.store.name}の空欄の日に入れる金額`}
                                  unit="円"
                                  inputMode="numeric"
                                  autoComplete="off"
                                  form="budget-daily-fill-only"
                                  readOnly={syncedIds.has(p.store.id)}
                                  value={fills[p.store.id] ?? ""}
                                  onChange={(e) => {
                                    const v = e.currentTarget.value;
                                    setFills((prev) => ({ ...prev, [p.store.id]: v }));
                                  }}
                                />
                                <Button
                                  size="slim"
                                  onClick={() => fillEmptyDays(p.store.id)}
                                  disabled={syncedIds.has(p.store.id) || !fill.ok || fill.value === null || p.emptyDays === 0}
                                  accessibilityLabel={`${p.store.name}の空欄の ${p.emptyDays} 日に入れる`}
                                >
                                  {`${p.emptyDays} 日に入れる`}
                                </Button>
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    )}
                    {data.days.map((d) => {
                      const weekend = d.weekday === 0 || d.weekday === 6;
                      const isToday = d.date === data.today;
                      return (
                        <tr key={d.date} className={isToday ? "is-today" : undefined}>
                          <th scope="row" className={`BudgetDaily-date${weekend ? " is-weekend" : ""}`}>
                            {shortDateLabel(d.date)}（{d.weekdayLabel}）{isToday ? " 今日" : ""}
                          </th>
                          {perStore.map((p) => {
                            const error = p.errorByDate.get(d.date) ?? rowErrors?.[p.store.id]?.[d.date];
                            const change = p.changeByDate.get(d.date);
                            return (
                              <td
                                key={p.store.id}
                                className={colClass(p.store.id, `BudgetDaily-cell${error ? " is-error" : change ? " is-changed" : ""}`)}
                              >
                                <UnitInput
                                  label={`${p.store.name} ${shortDateLabel(d.date)}（${d.weekdayLabel}）の予算`}
                                  unit="円"
                                  name={`${AMOUNT_PREFIX}${numericLocationId(p.store.id)}.${d.date}`}
                                  inputMode="numeric"
                                  autoComplete="off"
                                  value={inputs[p.store.id]?.[d.date] ?? ""}
                                  onChange={(e) => setDay(p.store.id, d.date, e.currentTarget.value)}
                                  readOnly={readOnly || syncedIds.has(p.store.id)}
                                  aria-invalid={error ? true : undefined}
                                />
                                {error ? <div className="BudgetDaily-err" role="alert">{error}</div> : null}
                                {!error && change ? (
                                  <div className="BudgetDaily-note">
                                    {change.kind === "remove" ? "削除（前 " + fmtBudget(change.before) + "）" : change.kind === "add" ? "追加" : `変更（前 ${fmtBudget(change.before)}）`}
                                  </div>
                                ) : null}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
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
