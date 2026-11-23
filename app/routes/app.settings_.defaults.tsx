/**
 * /app/settings/defaults — 全店の決まり
 *
 * 保存すると、決まりと同じだった店（全店と同じの店）を新しい決まりに書き換える。店ごとに変えている項目は残す。
 * 書くのは Location の列（精算・売上サマリーが読む値）と AppSetting の決まり。読む側の処理は変えない。
 */
import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useLocation, useNavigate, useNavigation } from "react-router";
import { Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getFullAccess } from "../utils/planFeatures.server";
import {
  currentDefaults,
  getStoredDefaults,
  knownLocationIds,
  loadStoreLocations,
  lockedKeysForPlan,
  saveStoredDefaults,
  writeLocationUpdates,
} from "../utils/locationDefaults.server";
import { DEFAULTABLE_KEYS, DEFAULT_GROUPS, planDefaultsChange, readDefaultsForm, type LocationDefaults } from "../utils/locationDefaults";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { StoreBody } from "../components/StoreBody";
import { AdminBlock, AdminIntro, SaveBar, StatusBanner, SuccessToast } from "../components/admin-ui";
import { withSearch } from "../utils/withSearch";

async function load(request: Request) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const fullAccess = await getFullAccess(admin, session);
  const locked = lockedKeysForPlan(fullAccess, shop.planCode);
  const stored = await getStoredDefaults(shop.id);
  const locations = await loadStoreLocations(admin, shop.id);
  return { shop, locked, stored, locations, ...currentDefaults(locations, stored) };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { locked, stored, locations, defaults, saved } = await load(request);
  return {
    defaults,
    saved,
    savedAt: stored?.savedAt ?? "",
    locked,
    locations: locations.map((loc) => {
      const values = {} as LocationDefaults;
      for (const key of DEFAULTABLE_KEYS) values[key] = loc[key];
      return { id: loc.id, name: loc.displayName || loc.name, ...values };
    }),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { shop, locked, locations, defaults } = await load(request);
  const form = await request.formData();
  const next = readDefaultsForm(form, defaults, locked);
  const plan = planDefaultsChange(locations, defaults, next, locked);
  try {
    await writeLocationUpdates(shop.id, locations, plan.updates);
    await saveStoredDefaults(shop.id, next, await knownLocationIds(shop.id, locations));
  } catch (error) {
    console.error("[settings/defaults] save failed", error);
    return { ok: false as const, error: "保存できませんでした。少し待ってからもう一度保存してください。" };
  }
  return { ok: true as const, changed: plan.updates.length, at: Date.now() };
}

export default function StoreDefaultsPage() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const q = useLocation().search || "";
  const busy = navigation.state === "submitting";
  return (
    <PolarisPageWrapper>
      <Page title="全店の決まり" backAction={{ content: "店舗", onAction: () => navigate(withSearch("/app/settings", q)) }}>
        <StoreBody>
        <SuccessToast trigger={result} message={result?.ok ? (result.changed > 0 ? `保存しました（${result.changed} 店を変更）` : "保存しました") : null} />
        {!busy && result && !result.ok ? <StatusBanner tone="critical" heading="保存できませんでした">{result.error}</StatusBanner> : null}
        {/* 保存のたびに開き直す（帯の基準を保存した値にする） */}
        <DefaultsForm key={`${data.savedAt}`} data={data} failed={!busy && Boolean(result && !result.ok)} />
        </StoreBody>
      </Page>
    </PolarisPageWrapper>
  );
}

function DefaultsForm({ data, failed }: { data: ReturnType<typeof useLoaderData<typeof loader>>; failed: boolean }) {
  const [values, setValues] = useState<LocationDefaults>(data.defaults);
  const plan = useMemo(() => planDefaultsChange(data.locations, data.defaults, values, data.locked), [data, values]);
  const changedNames = plan.updates.map((u) => data.locations.find((loc) => loc.id === u.id)?.name ?? "");

  return (
    <Form method="post">
      <AdminIntro>
        <p>
          {data.saved ? "" : "まだ保存していません。今いちばん多い設定を出しています。"}
          全店と同じの店は、ここで決めた設定になります。店ごとに変えている項目はそのまま残ります（今 {plan.customCount} 店）。
        </p>
        {/* まだ保存していないときは、変えなくても今の内容で保存できるようにする（あとから足した店にこの決まりを当てるため） */}
        {data.saved ? null : <p><button type="submit" className="Admin-secondary">この内容で決まりを保存する</button></p>}
      </AdminIntro>
      {DEFAULT_GROUPS.map((group) => (
        <AdminBlock key={group.key} title={group.title} description={group.description}>
          {group.items.map((item) => {
            const locked = data.locked.includes(item.key);
            return (
              <label key={item.key}>
                <input
                  type="checkbox"
                  name={item.key}
                  checked={values[item.key]}
                  disabled={locked}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setValues((prev) => ({ ...prev, [item.key]: checked }));
                  }}
                />
                <span>
                  {item.label}
                  {locked ? <span className="Admin-note">（プロプランで使えます）</span> : null}
                </span>
              </label>
            );
          })}
        </AdminBlock>
      ))}
      <AdminBlock title="保存すると変わる店" description="店ごとに変えている項目は変わりません。">
        <p className="Admin-note" aria-live="polite">
          {plan.updates.length === 0
            ? "今の内容では、どの店も変わりません。"
            : `${plan.updates.length} 店が変わります: ${changedNames.slice(0, 8).join("・")}${changedNames.length > 8 ? ` ほか ${changedNames.length - 8} 店` : ""}`}
        </p>
      </AdminBlock>
      <SaveBar failed={failed} onDiscard={() => setValues(data.defaults)} />
    </Form>
  );
}
