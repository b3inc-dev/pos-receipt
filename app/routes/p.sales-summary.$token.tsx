/**
 * ブラウザ直アクセス用 日次売上サマリー（トークンURL）
 * - 1 ショップ 1 トークン（DB はハッシュのみ）
 * - ロケーション未指定 = POS と同様「全店」＋表示対象フィルタは設定に従う
 */
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import { unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { hashSalesSummaryPublicToken } from "../utils/salesSummaryPublicToken.server";
import { buildDailySalesSummaryPayload } from "../services/salesSummaryDailyPayload.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";
import type { DailySalesSummaryPayload } from "../services/salesSummaryDailyPayload.server";

export const meta: MetaFunction = () => [
  { title: "売上サマリー" },
  { name: "robots", content: "noindex, nofollow" },
];

function addDaysIso(ymd: string, delta: number): string {
  const d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" });
const num = new Intl.NumberFormat("ja-JP");

function cell(v: string | number | null | undefined, suffix = ""): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number" && !Number.isFinite(v)) return "—";
  if (typeof v === "number") return num.format(v) + suffix;
  return String(v);
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

    const url = new URL(request.url);
    const dateParam = url.searchParams.get("date");
    const payload = await buildDailySalesSummaryPayload(admin, shop, {
      targetDate: dateParam,
      locationIdsParam: [],
    });

    return {
      kind: "ok" as const,
      payload,
      tokenForLinks: raw,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "読み込みに失敗しました";
    return { kind: "error" as const, message };
  }
}

type LoaderOk = {
  kind: "ok";
  payload: DailySalesSummaryPayload;
  tokenForLinks: string;
};

function SummaryTable({ data }: { data: LoaderOk }) {
  const { payload, tokenForLinks } = data;
  const o = payload.displayOptions;
  const { targetDate, calendarToday, rows, channelRows, totals } = payload;

  const prev = addDaysIso(targetDate, -1);
  const next = addDaysIso(targetDate, 1);
  const nextDisabled = targetDate >= calendarToday;
  const base = `/p/sales-summary/${encodeURIComponent(tokenForLinks)}`;

  const showLoc = o.showLocationRows !== false && rows.length > 0;
  const showCh = o.showChannelRows !== false && channelRows.length > 0;

  return (
    <div style={{ marginTop: "20px" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "12px",
          marginBottom: "16px",
        }}
      >
        <Link
          to={`${base}?date=${prev}`}
          style={{ color: "#2c6ecb", textDecoration: "none", fontSize: "15px" }}
        >
          ← 前日
        </Link>
        <span style={{ fontSize: "16px", fontWeight: 600 }}>
          {targetDate.replace(/-/g, "/")}
          {targetDate === calendarToday ? "（今日）" : ""}
        </span>
        {!nextDisabled ? (
          <Link
            to={`${base}?date=${next}`}
            style={{ color: "#2c6ecb", textDecoration: "none", fontSize: "15px" }}
          >
            翌日 →
          </Link>
        ) : (
          <span style={{ color: "#8c9196", fontSize: "15px" }}>翌日 →</span>
        )}
      </div>

      {showLoc ? (
        <div style={{ overflowX: "auto", marginBottom: "20px" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "14px",
              background: "#fff",
              boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
            }}
          >
            <thead>
              <tr style={{ background: "#f6f6f7", borderBottom: "1px solid #e1e3e5" }}>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>店舗</th>
                {o.showActual !== false ? (
                  <th style={{ textAlign: "right", padding: "10px 12px" }}>実績</th>
                ) : null}
                {o.showBudget ? <th style={{ textAlign: "right", padding: "10px 12px" }}>予算</th> : null}
                {o.showBudgetRatio ? <th style={{ textAlign: "right", padding: "10px 12px" }}>予算比</th> : null}
                {o.showOrders ? <th style={{ textAlign: "right", padding: "10px 12px" }}>注文</th> : null}
                {o.showItems ? <th style={{ textAlign: "right", padding: "10px 12px" }}>商品数</th> : null}
                {o.showVisitors ? <th style={{ textAlign: "right", padding: "10px 12px" }}>入店</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.locationId} style={{ borderBottom: "1px solid #e1e3e5" }}>
                  <td style={{ padding: "10px 12px" }}>{r.locationName}</td>
                  {o.showActual !== false ? (
                    <td style={{ textAlign: "right", padding: "10px 12px" }}>{yen.format(r.actual)}</td>
                  ) : null}
                  {o.showBudget ? (
                    <td style={{ textAlign: "right", padding: "10px 12px" }}>
                      {r.budget != null ? yen.format(r.budget) : "—"}
                    </td>
                  ) : null}
                  {o.showBudgetRatio ? (
                    <td style={{ textAlign: "right", padding: "10px 12px" }}>
                      {r.budgetRatio != null ? `${(r.budgetRatio * 100).toFixed(1)}%` : "—"}
                    </td>
                  ) : null}
                  {o.showOrders ? (
                    <td style={{ textAlign: "right", padding: "10px 12px" }}>{cell(r.orders)}</td>
                  ) : null}
                  {o.showItems ? (
                    <td style={{ textAlign: "right", padding: "10px 12px" }}>{cell(r.items)}</td>
                  ) : null}
                  {o.showVisitors ? (
                    <td style={{ textAlign: "right", padding: "10px 12px" }}>
                      {r.visitors != null ? cell(r.visitors) : "—"}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {showCh ? (
        <div style={{ overflowX: "auto", marginBottom: "20px" }}>
          <h2 style={{ fontSize: "16px", margin: "0 0 8px", color: "#202223" }}>チャネル</h2>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "14px",
              background: "#fff",
              boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
            }}
          >
            <thead>
              <tr style={{ background: "#f6f6f7", borderBottom: "1px solid #e1e3e5" }}>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>チャネル</th>
                {o.showActual !== false ? (
                  <th style={{ textAlign: "right", padding: "10px 12px" }}>実績</th>
                ) : null}
                {o.showBudget ? <th style={{ textAlign: "right", padding: "10px 12px" }}>予算</th> : null}
                {o.showOrders ? <th style={{ textAlign: "right", padding: "10px 12px" }}>注文</th> : null}
              </tr>
            </thead>
            <tbody>
              {channelRows.map((r) => (
                <tr key={r.channelId} style={{ borderBottom: "1px solid #e1e3e5" }}>
                  <td style={{ padding: "10px 12px" }}>{r.channelName}</td>
                  {o.showActual !== false ? (
                    <td style={{ textAlign: "right", padding: "10px 12px" }}>{yen.format(r.actual)}</td>
                  ) : null}
                  {o.showBudget ? (
                    <td style={{ textAlign: "right", padding: "10px 12px" }}>
                      {r.budget != null ? yen.format(r.budget) : "—"}
                    </td>
                  ) : null}
                  {o.showOrders ? (
                    <td style={{ textAlign: "right", padding: "10px 12px" }}>{cell(r.orders)}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {o.showOverallTotals !== false ? (
        <div
          style={{
            padding: "16px",
            background: "#f1f2f4",
            borderRadius: "8px",
            fontSize: "15px",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: "8px", color: "#202223" }}>全体合計</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "16px 24px" }}>
            {o.showActual !== false ? (
              <span>
                実績 <strong>{yen.format(totals.actual)}</strong>
              </span>
            ) : null}
            {o.showBudget && totals.budget != null ? (
              <span>
                予算 <strong>{yen.format(totals.budget)}</strong>
              </span>
            ) : null}
            {o.showOrders ? (
              <span>
                注文 <strong>{cell(totals.orders)}</strong>
              </span>
            ) : null}
            {o.showItems ? (
              <span>
                商品数 <strong>{cell(totals.items)}</strong>
              </span>
            ) : null}
            {o.showVisitors && totals.visitors != null ? (
              <span>
                入店 <strong>{cell(totals.visitors)}</strong>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {!showLoc && !showCh ? (
        <p style={{ color: "#6d7175" }}>
          表示できるデータがありません。売上サマリー設定で対象店舗や表示項目を確認してください。
        </p>
      ) : null}
    </div>
  );
}

export default function PublicSalesSummaryPage() {
  const data = useLoaderData<typeof loader>();

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
        maxWidth: "900px",
        margin: "0 auto",
        color: "#202223",
        background: "#fafbfb",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: "22px", fontWeight: 700, margin: "0 0 4px" }}>売上サマリー</h1>
      <p style={{ margin: 0, fontSize: "14px", color: "#6d7175" }}>全店合計（日次）</p>
      <SummaryTable data={data} />
    </div>
  );
}
