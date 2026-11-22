/**
 * 「DB の planCode は Pro なのに、Shopify に有効な Pro の契約が無い店」を探す（レビュー P2-5）。
 *
 * 前の穴: /app/plan/callback?plan=pro を開くだけで Shop.planCode が pro になった（今はふさいだ。DECISIONS.md）。
 * 今の門番（checkShopPlanAccess）は、店がアプリを開いて契約を読めたときに planCode を契約の値へ直す。
 * でも、その後アプリを開いていない店は DB に pro が残る。その店を一覧にする。
 *
 * 読むだけ。DB にも Shopify にも書かない（planCode を直さない・トークンを新しくしない）。
 * プランの読み方は門番と同じ関数（shopPlan.server.ts の planFromSubscriptions）を使う。
 */
import { planFromSubscriptions } from "../../app/utils/shopPlan.server.ts";
import {
  fetchPartnerActiveSubscription,
  partnerSubscriptionToAdminShape,
  readPartnerApiConfig,
} from "../../app/utils/partnerSubscription.server.ts";

/** 調べる planCode。pro は前の穴でなりうる値。unlimited は手で付ける例外（一覧には出すが「ずれ」とは数えない） */
export const PAID_PLAN_CODES = ["pro", "unlimited"];

/** Admin API の版（app/shopify.server.ts の ApiVersion.October25 と同じ） */
export const ADMIN_API_VERSION = "2025-10";

export const ADMIN_SUBSCRIPTIONS_QUERY = `query PlanMismatchReport {
  shop { plan { partnerDevelopment } }
  currentAppInstallation { activeSubscriptions { name status } }
}`;

/**
 * Admin API で契約を読む（店のオフラインのトークン）。投げない。
 * トークンの期限が切れていたら聞かない（新しくするとアプリが持っているトークンが使えなくなるため、ここでは新しくしない）。
 */
export async function readAdminSubscriptions({ shopDomain, session, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10_000 }) {
  if (!session || !session.accessToken) return { ok: false, reason: "no_offline_session" };
  if (session.expires && new Date(session.expires).getTime() <= now()) return { ok: false, reason: "token_expired" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query: ADMIN_SUBSCRIPTIONS_QUERY }),
      signal: controller.signal,
    });
    if (resp.status === 401 || resp.status === 403) return { ok: false, reason: `admin_http_${resp.status}` };
    if (resp.status === 402) return { ok: false, reason: "admin_http_402_frozen" };
    if (resp.status === 404) return { ok: false, reason: "admin_http_404" };
    if (resp.status < 200 || resp.status >= 300) return { ok: false, reason: `admin_http_${resp.status}` };
    const json = await resp.json().catch(() => null);
    const subs = json?.data?.currentAppInstallation?.activeSubscriptions;
    if (!Array.isArray(subs)) return { ok: false, reason: "admin_bad_response" };
    return {
      ok: true,
      source: "admin",
      subscriptions: subs.map((s) => ({ name: String(s?.name ?? ""), status: String(s?.status ?? "") })),
      isDevelopmentStore: json?.data?.shop?.plan?.partnerDevelopment === true,
    };
  } catch (e) {
    const aborted = controller.signal.aborted || (e instanceof Error && e.name === "AbortError");
    return { ok: false, reason: aborted ? "admin_timeout" : "admin_network_error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Partner API の設定を読む。アプリの門番のスイッチ（PARTNER_API_SUBSCRIPTION_ENABLED）がオフでも、
 * 値（PARTNER_API_TOKEN・PARTNER_API_ORG_ID・PARTNER_API_APP_ID）がそろっていれば、この診断だけは読みに使う。
 * スイッチ自体は変えない（アプリの動きは変わらない）。
 */
export function readPartnerConfigForReport(env) {
  const r = readPartnerApiConfig({ ...env, PARTNER_API_SUBSCRIPTION_ENABLED: "1" });
  return r.enabled ? r.config : null;
}

/** Partner API で契約を読む（店のトークンが要らない）。投げない */
export async function readPartnerSubscriptions({ config, shopGid, fetchImpl }) {
  if (!config) return { ok: false, reason: "partner_not_configured" };
  const r = await fetchPartnerActiveSubscription({ config, shopGid, ...(fetchImpl ? { fetchImpl } : {}) });
  if (!r.ok) return { ok: false, reason: `partner_${r.reason}` };
  const subs = r.subscription ? [partnerSubscriptionToAdminShape(r.subscription, shopGid)] : [];
  return { ok: true, source: "partner", subscriptions: subs.map((s) => ({ name: s.name, status: s.status })) };
}

/** 契約の一覧を人が読める 1 行にする（例: "ACTIVE:Lite" / "なし"） */
export function describeSubscriptions(subs) {
  if (!subs || subs.length === 0) return "なし";
  return subs.map((s) => `${s.status || "?"}:${s.name || "(名前なし)"}`).join(", ");
}

/**
 * 1 店を分ける（純粋な関数）。
 * - manual: DB が unlimited（手で付けた例外）。ずれとは数えない
 * - exempt: CUSTOM_APP_STORE_IDS・開発ストア（門番が全機能にする店）
 * - unread: どちらの API でも契約を読めなかった（ずれとは言えない）
 * - ok: 有効な Pro の契約がある
 * - mismatch: 契約を読めたのに Pro の有効な契約が無い ← T が扱いを決める店
 */
export function classifyShop({ planCode, customStore, reads }) {
  const okReads = (reads ?? []).filter((r) => r && r.ok);
  const subs = okReads.flatMap((r) => r.subscriptions ?? []);
  const isDevelopmentStore = okReads.some((r) => r.isDevelopmentStore === true);
  const subscriptionPlan = okReads.length > 0 ? planFromSubscriptions(subs) : null;
  const base = {
    subscriptions: describeSubscriptions(subs),
    subscriptionPlan,
    source: okReads.map((r) => r.source).join("+") || "-",
    reason: (reads ?? []).filter((r) => r && !r.ok).map((r) => r.reason).join(",") || "",
  };
  if (planCode === "unlimited") return { verdict: "manual", ...base };
  if (customStore) return { verdict: "exempt", ...base, reason: "custom_app_store_ids" };
  if (isDevelopmentStore) return { verdict: "exempt", ...base, reason: "development_store" };
  if (okReads.length === 0) return { verdict: "unread", ...base, subscriptions: "-" };
  if (subscriptionPlan === "pro") return { verdict: "ok", ...base };
  return { verdict: "mismatch", ...base };
}

/**
 * 一覧を作る。prisma は findMany だけを使う（書く関数は呼ばない）。
 * deps: { prisma, env, fetchImpl, now, onProgress }
 */
export async function buildPlanMismatchReport({ prisma, env = process.env, fetchImpl, now = Date.now, onlyShop = null }) {
  const where = { planCode: { in: PAID_PLAN_CODES } };
  if (onlyShop) where.shopDomain = onlyShop;
  const shops = await prisma.shop.findMany({
    where,
    select: { shopDomain: true, shopifyShopGid: true, planCode: true, updatedAt: true },
    orderBy: { shopDomain: "asc" },
  });
  const domains = shops.map((s) => s.shopDomain);
  const sessions = domains.length
    ? await prisma.session.findMany({
        where: { shop: { in: domains }, isOnline: false },
        select: { shop: true, accessToken: true, expires: true },
      })
    : [];
  const sessionByShop = new Map(sessions.map((s) => [s.shop, s]));
  const customIds = String(env.CUSTOM_APP_STORE_IDS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const partnerConfig = readPartnerConfigForReport(env);

  const rows = [];
  for (const shop of shops) {
    const shopDomain = String(shop.shopDomain ?? "").trim().toLowerCase();
    const reads = [];
    if (partnerConfig) {
      reads.push(await readPartnerSubscriptions({ config: partnerConfig, shopGid: shop.shopifyShopGid, fetchImpl }));
    }
    // Partner で Pro が見えなかったときだけ Admin も見る（払っている店を「ずれ」にしない）
    const partnerPro = reads.some((r) => r.ok && planFromSubscriptions(r.subscriptions) === "pro");
    if (!partnerPro) {
      reads.push(
        await readAdminSubscriptions({ shopDomain, session: sessionByShop.get(shop.shopDomain), fetchImpl, now })
      );
    }
    rows.push({
      shopDomain,
      planCode: shop.planCode,
      dbUpdatedAt: shop.updatedAt ? new Date(shop.updatedAt).toISOString() : null,
      ...classifyShop({ planCode: shop.planCode, customStore: customIds.includes(shopDomain), reads }),
    });
  }
  const counts = { mismatch: 0, ok: 0, unread: 0, exempt: 0, manual: 0 };
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  return { rows, counts, partnerUsed: Boolean(partnerConfig) };
}

const VERDICT_LABEL = {
  mismatch: "ずれ（Pro の契約なし）",
  ok: "OK（Pro の契約あり）",
  unread: "読めない",
  exempt: "例外（全機能の店）",
  manual: "手で付けた unlimited",
};

/** 表にする（タブ区切り。Render の画面からそのまま表計算に貼れる） */
export function formatPlanMismatchReport(report) {
  const head = ["判定", "店", "DBのプラン", "契約", "契約から読んだプラン", "読んだ所", "読めない理由", "DBの更新日時"];
  const order = ["mismatch", "unread", "manual", "exempt", "ok"];
  const rows = [...report.rows].sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict));
  const lines = [head.join("\t")];
  for (const r of rows) {
    lines.push(
      [
        VERDICT_LABEL[r.verdict] ?? r.verdict,
        r.shopDomain,
        r.planCode,
        r.subscriptions,
        r.subscriptionPlan ?? "-",
        r.source,
        r.reason || "-",
        r.dbUpdatedAt ?? "-",
      ].join("\t")
    );
  }
  const c = report.counts;
  lines.push("");
  lines.push(
    `合計 ${report.rows.length} 店: ずれ ${c.mismatch} / 読めない ${c.unread} / unlimited ${c.manual} / 例外 ${c.exempt} / OK ${c.ok}` +
      `（Partner API: ${report.partnerUsed ? "使った" : "設定なし・使っていない"}）`
  );
  lines.push("何も書きかえていません（読むだけ）。");
  return lines.join("\n");
}
