/**
 * ブラウザ直アクセス用 売上サマリー（トークンURL）
 * - 日次 / 月次 / 期間（POS の API と同じデータ）
 * - KPI 行は POS タイルと同じ並び（publicSalesSummaryKpi）
 */
import type { ReactNode } from "react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, Link, useLoaderData, useNavigation } from "react-router";
import { unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { hashSalesSummaryPublicToken } from "../utils/salesSummaryPublicToken.server";
import { buildDailySalesSummaryPayload } from "../services/salesSummaryDailyPayload.server";
import { buildPeriodSalesSummaryPayload } from "../services/salesSummaryPeriodPayload.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";
import type { DailySalesSummaryPayload } from "../services/salesSummaryDailyPayload.server";
import { getShopTimezoneForDaily, getCalendarDateStringInTimeZone } from "../utils/shopTimezone.server";
import {
  buildDailyKpiLinesWithMonth,
  buildDailyTotalsLines,
  buildPeriodKpiLines,
  buildPeriodTotalsLines,
  mergeDailyTotalsWithMonth,
  pickPeriodRowForDailyLine,
  type KpiLine,
  type PeriodRowLike,
  type SalesSummaryDisplayOpts,
} from "../utils/publicSalesSummaryKpi";

export const meta: MetaFunction = () => [
  { title: "売上サマリー" },
  { name: "robots", content: "noindex, nofollow" },
];

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function addDaysIso(ymd: string, delta: number): string {
  const d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addMonthsYm(y: number, m: number, delta: number): { y: number; m: number } {
  const d = new Date(y, m - 1 + delta, 1);
  return { y: d.getFullYear(), m: d.getMonth() + 1 };
}

/** 日次画面用：その日を含む月の MTD 範囲（POS の monthRangeForTargetDate に合わせる） */
function monthPeriodRangeForDailyContext(viewDateYmd: string, calendarToday: string) {
  const parts = viewDateYmd.split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  if (!y || !m || m < 1 || m > 12) return null;
  const dateFrom = `${y}-${pad2(m)}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const lastStr = `${y}-${pad2(m)}-${pad2(lastDay)}`;
  let dateTo = viewDateYmd;
  if (dateTo > lastStr) dateTo = lastStr;
  if (dateTo > calendarToday) dateTo = calendarToday;
  return { dateFrom, dateTo, budgetDateTo: lastStr };
}

function monthRangeCalendarMonth(year: number, month: number, calendarToday: string) {
  const dateFrom = `${year}-${pad2(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const lastStr = `${year}-${pad2(month)}-${pad2(lastDay)}`;
  const dateTo = lastStr > calendarToday ? calendarToday : lastStr;
  return { dateFrom, dateTo, budgetDateTo: lastStr };
}

function KpiBlock({ title, lines }: { title: ReactNode; lines: KpiLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div
      style={{
        border: "1px solid #e1e3e5",
        borderRadius: "8px",
        overflow: "hidden",
        marginBottom: "12px",
        background: "#fff",
      }}
    >
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #e1e3e5", background: "#fafbfb" }}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#202223" }}>{title}</div>
      </div>
      <div>
        {lines.map((r, i) => (
          <div
            key={`${r.label}-${i}`}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "12px",
              padding: "10px 12px",
              borderBottom: i < lines.length - 1 ? "1px solid #e1e3e5" : undefined,
              fontSize: "14px",
            }}
          >
            <span style={{ color: "#6d7175" }}>{r.label}</span>
            <span style={{ fontWeight: r.valueBold ? 700 : 500, textAlign: "right" }}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const raw = params.token?.trim() ?? "";
  if (!raw || raw.length < 16) {
    return { kind: "not_found" as const };
  }

  const tokenHash = hashSalesSummaryPublicToken(raw);
  const shop = await prisma.shop.findFirst({
    where: { salesSummaryPublicTokenHash: tokenHash },
  });

  if (!shop) {
    return { kind: "not_found" as const };
  }

  try {
    const { admin } = await unauthenticated.admin(shop.shopDomain);
    const fullAccess = await getFullAccess(admin, { shop: shop.shopDomain });
    const access = checkPlanAccess(shop.planCode, "sales_summary", fullAccess);
    if (!access.allowed) {
      return { kind: "forbidden" as const, message: access.message };
    }

    const shopIanaTz = await getShopTimezoneForDaily(admin, shop.id);
    const calendarToday = getCalendarDateStringInTimeZone(new Date(), shopIanaTz);

    const url = new URL(request.url);
    const mode = (url.searchParams.get("mode") || "daily").toLowerCase();
    const token = raw;

    if (mode === "month") {
      let y = parseInt(url.searchParams.get("y") || "", 10);
      let m = parseInt(url.searchParams.get("m") || "", 10);
      const monthStr = url.searchParams.get("month");
      if (monthStr && /^\d{4}-\d{2}$/.test(monthStr)) {
        const [yy, mm] = monthStr.split("-").map(Number);
        y = yy;
        m = mm;
      }
      if (!y || !m || m < 1 || m > 12) {
        const [cy, cm] = calendarToday.split("-").map(Number);
        y = cy;
        m = cm;
      }
      const { dateFrom, dateTo, budgetDateTo } = monthRangeCalendarMonth(y, m, calendarToday);
      const period = await buildPeriodSalesSummaryPayload(admin, shop, {
        dateFrom,
        dateTo,
        budgetDateTo,
        locationIdsParam: [],
      });
      return {
        kind: "ok" as const,
        view: "month" as const,
        period,
        token,
        calendarToday,
        year: y,
        month: m,
      };
    }

    if (mode === "period") {
      let from = url.searchParams.get("from");
      let to = url.searchParams.get("to");
      if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        const [cy, cm] = calendarToday.split("-").map(Number);
        const mr = monthRangeCalendarMonth(cy, cm, calendarToday);
        from = mr.dateFrom;
        to = mr.dateTo;
      }
      if (from > to) {
        const t = from;
        from = to;
        to = t;
      }
      const period = await buildPeriodSalesSummaryPayload(admin, shop, {
        dateFrom: from,
        dateTo: to,
        budgetDateTo: to,
        locationIdsParam: [],
      });
      return {
        kind: "ok" as const,
        view: "period" as const,
        period,
        token,
        calendarToday,
        dateFrom: from!,
        dateTo: to!,
      };
    }

    // daily（既定）
    const dateParam = url.searchParams.get("date");
    const daily = await buildDailySalesSummaryPayload(admin, shop, {
      targetDate: dateParam,
      locationIdsParam: [],
    });

    const mr = monthPeriodRangeForDailyContext(daily.targetDate, daily.calendarToday);
    let monthPeriod: PeriodSalesSummaryPayload | null = null;
    if (mr) {
      monthPeriod = await buildPeriodSalesSummaryPayload(admin, shop, {
        dateFrom: mr.dateFrom,
        dateTo: mr.dateTo,
        budgetDateTo: mr.budgetDateTo,
        locationIdsParam: [],
      });
    }

    return {
      kind: "ok" as const,
      view: "daily" as const,
      daily,
      monthPeriod,
      token,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "読み込みに失敗しました";
    return { kind: "error" as const, message };
  }
}

function ModeTabs(props: {
  token: string;
  active: "daily" | "month" | "period";
  dailyQuery?: string;
  monthQuery?: string;
  periodQuery?: string;
}) {
  const { token, active } = props;
  const enc = encodeURIComponent(token);
  const base = `/p/sales-summary/${enc}`;
  const tab = (mode: string, label: string, q: string) => {
    const isOn = active === mode;
    return (
      <Link
        to={`${base}?${q}`}
        style={{
          padding: "8px 14px",
          borderRadius: "6px",
          textDecoration: "none",
          fontSize: "14px",
          fontWeight: isOn ? 700 : 500,
          color: isOn ? "#fff" : "#2c6ecb",
          background: isOn ? "#2c6ecb" : "#e3e5e8",
        }}
      >
        {label}
      </Link>
    );
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "20px" }}>
      {tab("daily", "日次", props.dailyQuery || "mode=daily")}
      {tab("month", "月次", props.monthQuery || "mode=month")}
      {tab("period", "期間", props.periodQuery || "mode=period")}
    </div>
  );
}

function DailyView(props: {
  data: Extract<Awaited<ReturnType<typeof loader>>, { kind: "ok"; view: "daily" }>;
}) {
  const { daily, monthPeriod, token } = props.data;
  const o = daily.displayOptions as SalesSummaryDisplayOpts;
  const { targetDate, calendarToday, rows, channelRows, totals } = daily;

  const prev = addDaysIso(targetDate, -1);
  const next = addDaysIso(targetDate, 1);
  const nextDisabled = targetDate >= calendarToday;
  const enc = encodeURIComponent(token);
  const base = `/p/sales-summary/${enc}`;
  const qDaily = `mode=daily&date=${targetDate}`;

  const showAllTotals = o.showOverallTotals !== false;
  const showLoc = o.showLocationRows !== false && rows.length > 0;
  const showCh = o.showChannelRows !== false && channelRows.length > 0;

  let totalsLines = buildDailyTotalsLines(
    {
      actual: totals.actual,
      budget: totals.budget,
      orders: totals.orders,
      items: totals.items,
      visitors: totals.visitors,
    },
    o,
  );
  if (monthPeriod && monthPeriod.totals && Object.keys(monthPeriod.totals).length > 0) {
    totalsLines = mergeDailyTotalsWithMonth(totalsLines, monthPeriod.totals as Parameters<typeof mergeDailyTotalsWithMonth>[1], o);
  }

  return (
    <div>
      <ModeTabs
        token={token}
        active="daily"
        dailyQuery={qDaily}
        monthQuery={`mode=month&month=${targetDate.slice(0, 7)}`}
        periodQuery={`mode=period&from=${targetDate.slice(0, 7)}-01&to=${targetDate}`}
      />

      <p style={{ margin: "0 0 12px", fontSize: "14px", color: "#6d7175" }}>
        日次（全店） {targetDate.replace(/-/g, "/")}
        {targetDate === calendarToday ? "（今日）" : ""}
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
        <Link to={`${base}?mode=daily&date=${prev}`} style={{ color: "#2c6ecb", textDecoration: "none" }}>
          ← 前日
        </Link>
        {!nextDisabled ? (
          <Link to={`${base}?mode=daily&date=${next}`} style={{ color: "#2c6ecb", textDecoration: "none" }}>
            翌日 →
          </Link>
        ) : (
          <span style={{ color: "#8c9196" }}>翌日 →</span>
        )}
      </div>

      {showAllTotals && totalsLines.length > 0 ? (
        <KpiBlock title="全店合計" lines={totalsLines} />
      ) : null}

      {showLoc
        ? rows.map((row) => {
            const pr = monthPeriod
              ? pickPeriodRowForDailyLine(
                  {
                    rows: monthPeriod.rows as PeriodRowLike[],
                    channelRows: monthPeriod.channelRows as PeriodRowLike[],
                  },
                  { locationId: row.locationId },
                )
              : null;
            const lines = buildDailyKpiLinesWithMonth(
              {
                actual: row.actual,
                budget: row.budget,
                budgetRatio: row.budgetRatio,
                orders: row.orders,
                visitors: row.visitors,
                conv: row.conv,
                atv: row.atv,
                setRate: row.setRate,
                items: row.items,
                unit: row.unit,
              },
              pr,
              o,
            );
            return <KpiBlock key={row.locationId} title={row.locationName ?? row.locationId} lines={lines} />;
          })
        : null}

      {showCh
        ? channelRows.map((row) => {
            const pr = monthPeriod
              ? pickPeriodRowForDailyLine(
                  {
                    rows: monthPeriod.rows as PeriodRowLike[],
                    channelRows: monthPeriod.channelRows as PeriodRowLike[],
                  },
                  { channelId: row.channelId },
                )
              : null;
            const lines = buildDailyKpiLinesWithMonth(
              {
                actual: row.actual,
                budget: row.budget,
                budgetRatio: row.budgetRatio,
                orders: row.orders,
                visitors: null,
                conv: null,
                atv: row.atv,
                setRate: row.setRate,
                items: row.items,
                unit: row.unit,
              },
              pr,
              o,
            );
            return (
              <KpiBlock key={row.channelId} title={`[${row.channelName ?? row.channelId}]`} lines={lines} />
            );
          })
        : null}

      {!showLoc && !showCh ? (
        <p style={{ color: "#6d7175" }}>表示できるデータがありません。売上サマリー設定を確認してください。</p>
      ) : null}
    </div>
  );
}

function MonthView(props: {
  data: Extract<Awaited<ReturnType<typeof loader>>, { kind: "ok"; view: "month" }>;
}) {
  const { period, token, calendarToday, year, month } = props.data;
  const o = period.displayOptions as SalesSummaryDisplayOpts;
  const { rows, channelRows, totals, dateFrom, dateTo } = period;
  const enc = encodeURIComponent(token);
  const base = `/p/sales-summary/${enc}`;
  const prev = addMonthsYm(year, month, -1);
  const next = addMonthsYm(year, month, 1);
  const cy = parseInt(calendarToday.slice(0, 4), 10);
  const cm = parseInt(calendarToday.slice(5, 7), 10);
  const disableNext = next.y > cy || (next.y === cy && next.m > cm);

  const locRows = rows as PeriodRowLike[];
  const chRows = channelRows as PeriodRowLike[];
  const showAllTotals = o.showOverallTotals !== false;
  const showLoc = o.showLocationRows !== false && locRows.length > 0;
  const showCh = o.showChannelRows !== false && chRows.length > 0;

  const totalsLines = buildPeriodTotalsLines(totals as Parameters<typeof buildPeriodTotalsLines>[0], o, locRows);

  return (
    <div>
      <ModeTabs
        token={token}
        active="month"
        dailyQuery={`mode=daily&date=${calendarToday}`}
        monthQuery={`mode=month&y=${year}&m=${month}`}
        periodQuery={`mode=period&from=${dateFrom}&to=${dateTo}`}
      />
      <p style={{ margin: "0 0 8px", fontSize: "14px", color: "#6d7175" }}>
        月次（全店） {year}年{month}月
      </p>
      <p style={{ margin: "0 0 12px", fontSize: "13px", color: "#6d7175" }}>
        期間: {String(dateFrom).replace(/-/g, "/")} 〜 {String(dateTo).replace(/-/g, "/")}
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", marginBottom: "16px" }}>
        <Link
          to={`${base}?mode=month&y=${prev.y}&m=${prev.m}`}
          style={{ color: "#2c6ecb", textDecoration: "none" }}
        >
          ← 前月
        </Link>
        {!disableNext ? (
          <Link
            to={`${base}?mode=month&y=${next.y}&m=${next.m}`}
            style={{ color: "#2c6ecb", textDecoration: "none" }}
          >
            翌月 →
          </Link>
        ) : (
          <span style={{ color: "#8c9196" }}>翌月 →</span>
        )}
      </div>

      {period.periodCachePartial ? (
        <p style={{ color: "#b98900", fontSize: "13px", marginBottom: "12px" }}>
          一部の日の集計が上限のため省略されています。時間をおいて再読み込みしてください。
        </p>
      ) : null}

      {showAllTotals && totalsLines.length > 0 ? <KpiBlock title="全体合計" lines={totalsLines} /> : null}

      {showLoc
        ? locRows.map((row) => (
            <KpiBlock
              key={String(row.locationId)}
              title={String(row.locationName ?? row.locationId)}
              lines={buildPeriodKpiLines(row, o)}
            />
          ))
        : null}
      {showCh
        ? chRows.map((row) => (
            <KpiBlock
              key={String(row.channelId)}
              title={`[${String(row.channelName ?? row.channelId)}]`}
              lines={buildPeriodKpiLines(row, o)}
            />
          ))
        : null}
    </div>
  );
}

function PeriodView(props: {
  data: Extract<Awaited<ReturnType<typeof loader>>, { kind: "ok"; view: "period" }>;
}) {
  const { period, token, calendarToday, dateFrom, dateTo } = props.data;
  const o = period.displayOptions as SalesSummaryDisplayOpts;
  const { rows, channelRows, totals } = period;
  const enc = encodeURIComponent(token);

  const locRows = rows as PeriodRowLike[];
  const chRows = channelRows as PeriodRowLike[];
  const showAllTotals = o.showOverallTotals !== false;
  const showLoc = o.showLocationRows !== false && locRows.length > 0;
  const showCh = o.showChannelRows !== false && chRows.length > 0;
  const totalsLines = buildPeriodTotalsLines(totals as Parameters<typeof buildPeriodTotalsLines>[0], o, locRows);

  return (
    <div>
      <ModeTabs
        token={token}
        active="period"
        dailyQuery={`mode=daily&date=${calendarToday}`}
        monthQuery={`mode=month&month=${dateFrom.slice(0, 7)}`}
        periodQuery={`mode=period&from=${dateFrom}&to=${dateTo}`}
      />
      <p style={{ margin: "0 0 8px", fontSize: "14px", color: "#6d7175" }}>期間指定（全店）</p>

      <Form
        method="get"
        style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "flex-end", marginBottom: "16px" }}
      >
        <input type="hidden" name="mode" value="period" />
        <label style={{ display: "flex", flexDirection: "column", fontSize: "13px", gap: "4px" }}>
          開始
          <input type="date" name="from" defaultValue={dateFrom} style={{ padding: "6px 8px" }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", fontSize: "13px", gap: "4px" }}>
          終了
          <input type="date" name="to" defaultValue={dateTo} style={{ padding: "6px 8px" }} />
        </label>
        <button type="submit" style={{ padding: "8px 16px", cursor: "pointer" }}>
          表示
        </button>
      </Form>

      <p style={{ margin: "0 0 12px", fontSize: "13px", color: "#6d7175" }}>
        {String(dateFrom).replace(/-/g, "/")} 〜 {String(dateTo).replace(/-/g, "/")}
      </p>

      {period.periodCachePartial ? (
        <p style={{ color: "#b98900", fontSize: "13px", marginBottom: "12px" }}>
          一部の日の集計が上限のため省略されています。
        </p>
      ) : null}

      {showAllTotals && totalsLines.length > 0 ? <KpiBlock title="全体合計" lines={totalsLines} /> : null}

      {showLoc
        ? locRows.map((row) => (
            <KpiBlock
              key={String(row.locationId)}
              title={String(row.locationName ?? row.locationId)}
              lines={buildPeriodKpiLines(row, o)}
            />
          ))
        : null}
      {showCh
        ? chRows.map((row) => (
            <KpiBlock
              key={String(row.channelId)}
              title={`[${String(row.channelName ?? row.channelId)}]`}
              lines={buildPeriodKpiLines(row, o)}
            />
          ))
        : null}
    </div>
  );
}

export default function PublicSalesSummaryPage() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state === "loading";

  if (data.kind === "not_found") {
    return (
      <div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "520px", margin: "0 auto" }}>
        <h1 style={{ fontSize: "20px" }}>リンクが無効です</h1>
        <p style={{ color: "#6d7175" }}>URL が間違っているか、公開リンクが無効化されています。</p>
      </div>
    );
  }

  if (data.kind === "forbidden") {
    return (
      <div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "520px", margin: "0 auto" }}>
        <h1 style={{ fontSize: "20px" }}>利用できません</h1>
        <p style={{ color: "#6d7175" }}>{data.message}</p>
      </div>
    );
  }

  if (data.kind === "error") {
    return (
      <div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "520px", margin: "0 auto" }}>
        <h1 style={{ fontSize: "20px" }}>エラー</h1>
        <p style={{ color: "#6d7175" }}>{data.message}</p>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: "24px 16px 48px",
        fontFamily: "system-ui, -apple-system, sans-serif",
        maxWidth: "560px",
        margin: "0 auto",
        color: "#202223",
        background: "#fafbfb",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: "22px", fontWeight: 700, margin: "0 0 4px" }}>売上サマリー</h1>
      <p style={{ margin: "0 0 16px", fontSize: "14px", color: "#6d7175" }}>公開ビュー（読み取り専用）</p>
      {busy ? (
        <p style={{ color: "#2c6ecb", marginBottom: "12px" }}>読み込み中…</p>
      ) : null}
      {data.view === "daily" ? <DailyView data={data} /> : null}
      {data.view === "month" ? <MonthView data={data} /> : null}
      {data.view === "period" ? <PeriodView data={data} /> : null}
    </div>
  );
}
