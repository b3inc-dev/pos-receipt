import { saveStoreOrder, StoreOrderError } from "../services/storeOrdering.server";
import { moveStore } from "../utils/storeOrdering";
/**
 * /app/settings — 店舗（一覧）
 *
 * 1 店 1 行の一覧と「全店の決まり」。編集はそれぞれ別の画面で行う（Shop Point と同じ「要約の行＋編集」。T 11/23）。
 * - 全店の決まり: /app/settings/defaults
 * - 店ごとの編集: /app/settings/store/:id
 * - 選んだ店をまとめて変更: /app/settings/bulk?ids=…
 * 精算・売上サマリーが読む Location の列はそのまま（ここは読むだけ。あとから足された店に決まりを当てるときだけ書く）。
 */
import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useLocation, useNavigation } from "react-router";
import { Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { isDevelopmentStore } from "../utils/devStore.server";
import { getFullAccess } from "../utils/planFeatures.server";
import {
  applyDefaultsToNewLocations,
  currentDefaults,
  getStoredDefaults,
  loadStoreLocations,
  lockedKeysForPlan,
} from "../utils/locationDefaults.server";
import { DEFAULTABLE_LABELS, DEFAULT_GROUPS, differingKeys, featureSummary, locationNumericId } from "../utils/locationDefaults";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, STORE_TABS } from "../components/TabGroupBar";
import { AdminBlock, AdminIntro, SecondaryLink, StateBadge, SummaryRows, SaveBar, StatusBanner, SuccessToast, useGuardedNavigate } from "../components/admin-ui";
import { withSearch } from "../utils/withSearch";
import { StoreBody } from "../components/StoreBody";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  // 「システム診断」の入口は開発ストアだけに出す（T さんの決定 2026-11-22。読めなければ出さない）
  const isDevStore = await isDevelopmentStore(admin);
  const fullAccess = await getFullAccess(admin, session);
  const locked = lockedKeysForPlan(fullAccess, shop.planCode);
  const stored = await getStoredDefaults(shop.id);
  const locations = await applyDefaultsToNewLocations(shop.id, await loadStoreLocations(admin, shop.id), stored, locked);
  const { defaults, saved } = currentDefaults(locations, stored);
  return {
    defaults,
    saved,
    isDevStore,
    locations: locations.map((loc) => ({
      id: locationNumericId(loc.id),
      name: loc.displayName || loc.name,
      shopifyName: loc.name,
      sortOrder: loc.sortOrder,
      features: featureSummary(loc, "features"),
      // 売上サマリーに出すかは店舗設定だけで決まる（T さん 2026-11-24）。一覧で 1 目で分かるようにする。プランで使えない店では出さない
      salesSummary: locked.includes("salesSummaryEnabled") ? null : loc.salesSummaryEnabled,
      differing: differingKeys(loc, defaults).map((key) => ({ key, label: DEFAULTABLE_LABELS[key], on: loc[key] })),
      nonPosRefund: loc.nonPosRefundAttributionEnabled,
    })),
  };
}

export async function action({request}: ActionFunctionArgs) {
  const {admin,session} = await authenticate.admin(request); const shop = await resolveShop(session.shop,admin);
  try {
    const form = await request.formData();
    const order = await saveStoreOrder(shop.id, JSON.parse(String(form.get("order"))), JSON.parse(String(form.get("baselineSortOrder"))));
    return {ok:true as const, order, at:Date.now()};
  } catch (error) { return {ok:false as const,error: error instanceof SyntaxError ? "表示順を読み取れませんでした。画面を開き直してください。" : error instanceof StoreOrderError ? error.message : "表示順を保存できませんでした。時間をおいてもう一度お試しください。"}; }
}

type Filter = "all" | "custom" | "same";

export default function StoresPage() {
  const { defaults, saved, isDevStore, locations } = useLoaderData<typeof loader>();
  const navigate = useGuardedNavigate();
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>();
  const [order,setOrder] = useState(locations.map((loc)=>loc.id));
  const [baseline,setBaseline] = useState(order);
  const [baselineSort,setBaselineSort] = useState(Object.fromEntries(locations.map((loc)=>[loc.id,loc.sortOrder])));
  const [positions,setPositions] = useState<Record<string,string>>({});
  const [dismissed,setDismissed] = useState(false);
  useEffect(()=>{setDismissed(false); if(actionData?.ok){setOrder(actionData.order);setBaseline(actionData.order);setBaselineSort(Object.fromEntries(actionData.order.map((id,i)=>[id,i+1])));setPositions({});}},[actionData]);
  const saving = navigation.state === "submitting";
  const orderedLocations = useMemo(()=>order.map(id=>locations.find(loc=>loc.id===id)).filter((loc): loc is typeof locations[number]=>!!loc),[locations,order]);
  const q = useLocation().search || "";
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string[]>([]);

  const customCount = locations.filter((loc) => loc.differing.length > 0).length;
  const shown = useMemo(() => {
    const word = query.trim().toLowerCase();
    return orderedLocations.filter((loc) => {
      if (filter === "custom" && loc.differing.length === 0) return false;
      if (filter === "same" && loc.differing.length > 0) return false;
      if (!word) return true;
      return loc.name.toLowerCase().includes(word) || loc.shopifyName.toLowerCase().includes(word);
    });
  }, [orderedLocations, query, filter]);
  const allShownSelected = shown.length > 0 && shown.every((loc) => selected.includes(loc.id));
  const toggle = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  const toggleShown = () =>
    setSelected((prev) => (allShownSelected ? prev.filter((id) => !shown.some((loc) => loc.id === id)) : [...new Set([...prev, ...shown.map((loc) => loc.id)])]));
  const nonPos = locations.find((loc) => loc.nonPosRefund);

  return (
    <PolarisPageWrapper>
      <Page title="店舗一覧" backAction={{ content: "ホーム", onAction: () => navigate("/app" + q) }}>
        <TabGroupBar tabs={STORE_TABS} />
        <StoreBody>
        <AdminIntro>
          <p>全店の決まりを 1 つ決めると、どの店もその設定になります。違う店だけ、店ごとに変えられます。</p>
        </AdminIntro>

        <AdminBlock
          title="全店の決まり"
          description={saved ? "あとから Shopify に足した店も、この決まりで始まります。" : "まだ保存していません。今いちばん多い設定を出しています。"}
        >
          <SummaryRows
            rows={[
              ...DEFAULT_GROUPS.map((group) => ({
                key: group.key,
                icon: group.key === "features" ? "apps" : "chart-vertical",
                title: <>{group.title}{saved ? null : <StateBadge label="未設定" />}</>,
                text: featureSummary(defaults, group.key),
                to: withSearch("/app/settings/defaults", q),
              })),
              {
                key: "non-pos-refund",
                icon: "return",
                title: "管理画面からの返金",
                text: nonPos ? `${nonPos.name} の精算に入れます` : "どの店にも決めていません（精算設定の決まりに従います）",
                to: nonPos ? withSearch(`/app/settings/store/${nonPos.id}`, q) : withSearch("/app/settlement-settings", q),
                actionLabel: nonPos ? "編集" : "精算設定へ",
              },
            ]}
          />
        </AdminBlock>

        <AdminBlock
          wide
          title={`店舗一覧（${locations.length} 店）`}
          description={customCount > 0 ? `${customCount} 店が、全店の決まりと違う設定です。` : "どの店も全店の決まりと同じです。"}
        >
          <Form method="post">
          <input type="hidden" name="order" value={JSON.stringify(order)} readOnly />
          <input type="hidden" name="baselineSortOrder" value={JSON.stringify(baselineSort)} readOnly />
          <SaveBar hasChanges={!saving && JSON.stringify(order)!==JSON.stringify(baseline)} failed={!saving && actionData?.ok===false && !dismissed}
            onDiscard={()=>{setOrder(baseline);setPositions({});setDismissed(true);}} />
          <SuccessToast message={actionData?.ok ? "保存しました" : null} trigger={actionData} />
          {actionData?.ok===false && !dismissed ? <StatusBanner tone="critical" heading="表示順を保存できませんでした">{actionData.error}</StatusBanner> : null}
          <p className="Admin-note">上下ボタン、または全{locations.length}店の中の表示位置を数字で変え、保存してください。数字は入力後に欄を離れると反映されます。</p>
          <div className="Admin-filters" data-not-form-value>
            <input
              type="search"
              className="Admin-input"
              placeholder="店の名前で探す"
              aria-label="店の名前で探す"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <select className="Admin-select" aria-label="絞り込み" value={filter} onChange={(event) => setFilter(event.currentTarget.value as Filter)}>
              <option value="all">すべての店</option>
              <option value="custom">全店と違う店</option>
              <option value="same">全店と同じ店</option>
            </select>
          </div>

          <div className="Store-bulk" role="group" aria-label="まとめて変更">
            <label className="Store-check">
              <input type="checkbox" checked={allShownSelected} onChange={toggleShown} disabled={shown.length === 0} />
              <span>表示中の店をすべて選ぶ</span>
            </label>
            <span className="Admin-note">{selected.length > 0 ? `${selected.length} 店を選択中` : "店を選ぶと、まとめて変更できます"}</span>
            <button
              type="button"
              className="Admin-secondary Admin-button-sm"
              disabled={selected.length === 0}
              onClick={() => navigate(withSearch("/app/settings/bulk", q, { ids: selected.join(",") }))}
            >
              選んだ店をまとめて変更
            </button>
          </div>

          {shown.length === 0 ? (
            <p className="Admin-note">{locations.length === 0 ? "Shopify に使っている店（ロケーション）がありません。" : "条件に合う店はありません。"}</p>
          ) : (
            <div data-summary-rows="true">
              {shown.map((loc, visibleIndex) => (
                <div key={loc.id} className="Admin-sum-row Store-order-row">
                  <input
                    type="checkbox"
                    className="Store-row-check"
                    aria-label={`${loc.name} を選ぶ`}
                    checked={selected.includes(loc.id)}
                    onChange={() => toggle(loc.id)}
                  />
                  <div className="Admin-sum-body">
                    <div className="Admin-sum-title">
                      {loc.name}
                      {loc.differing.length > 0 ? <StateBadge label={`全店と違う ${loc.differing.length} 項目`} tone="info" /> : <StateBadge label="全店と同じ" tone="success" />}
                    </div>
                    <div className="Admin-sum-text">
                      使う機能: {loc.features}
                      {loc.salesSummary === null ? "" : `　／　売上サマリー: ${loc.salesSummary ? "出す" : "出さない"}`}
                      {loc.differing.length > 0 ? `　／　違う所: ${loc.differing.map((d) => `${d.label}（${d.on ? "する" : "しない"}）`).join("・")}` : ""}
                    </div>
                    {loc.shopifyName !== loc.name ? <div className="Admin-sum-text">Shopify の名前: {loc.shopifyName}</div> : null}
                  </div>
                  <div className="Store-row-order">
                    <button type="button" className="Admin-secondary Admin-button-sm" aria-label={`${loc.name} を上へ`} disabled={visibleIndex===0 || saving}
                      onClick={()=>{setOrder(moveStore(order,loc.id,order.indexOf(shown[visibleIndex-1].id)+1));setPositions({});}}>↑</button>
                    <button type="button" className="Admin-secondary Admin-button-sm" aria-label={`${loc.name} を下へ`} disabled={visibleIndex===shown.length-1 || saving}
                      onClick={()=>{setOrder(moveStore(order,loc.id,order.indexOf(shown[visibleIndex+1].id)+1));setPositions({});}}>↓</button>
                    <input className="Admin-input" type="number" inputMode="numeric" min={1} max={locations.length} style={{width:72}} aria-label={`${loc.name} の表示位置`}
                      value={positions[loc.id] ?? String(order.indexOf(loc.id)+1)} disabled={saving}
                      onChange={(e)=>setPositions({...positions,[loc.id]:e.currentTarget.value})}
                      onBlur={()=>{setOrder(moveStore(order,loc.id,Number(positions[loc.id] ?? order.indexOf(loc.id)+1)));setPositions(prev=>{const next={...prev};delete next[loc.id];return next;});}}
                      onKeyDown={(e)=>{if(e.key==="Enter"){e.preventDefault();e.currentTarget.blur();}}} />
                    <SecondaryLink small to={withSearch(`/app/settings/store/${loc.id}`, q)}>編集</SecondaryLink>
                  </div>
                </div>
              ))}
            </div>
          )}
          </Form>
        </AdminBlock>

        {isDevStore ? (
          <AdminBlock title="システム診断" description="開発ストアだけに出ています。DB の接続や件数を確かめます。">
            <SecondaryLink to={withSearch("/app/diagnostics", q)}>診断を開く</SecondaryLink>
          </AdminBlock>
        ) : null}
        </StoreBody>
      </Page>
    </PolarisPageWrapper>
  );
}
