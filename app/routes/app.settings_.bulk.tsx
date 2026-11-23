/**
 * /app/settings/bulk?ids=1,2,3 — 選んだ店をまとめて変更
 *
 * 項目ごとに「変えない」「する」「しない」を選び、確かめてから反映する。選んだ店のうち値が変わる店だけ書く。
 * 書くのは Location の列だけ（精算・売上サマリーが読む値。読む側は変えない）。
 */
import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useLocation, useNavigate, useNavigation } from "react-router";
import { Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getFullAccess } from "../utils/planFeatures.server";
import { currentDefaults, getStoredDefaults, loadStoreLocations, lockedKeysForPlan, writeLocationUpdates } from "../utils/locationDefaults.server";
import {
  DEFAULTABLE_KEYS,
  DEFAULTABLE_LABELS,
  DEFAULT_GROUPS,
  locationGidFromNumeric,
  locationNumericId,
  planBulkChange,
  readBulkForm,
  type DefaultableKey,
  type LocationDefaults,
} from "../utils/locationDefaults";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { StoreBody } from "../components/StoreBody";
import { AdminBlock, AdminIntro, StatusBanner, SuccessToast } from "../components/admin-ui";

function readIds(raw: string | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((id) => locationGidFromNumeric(id.trim()))
    .filter((gid): gid is string => Boolean(gid));
}

async function load(request: Request, ids: string[]) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const fullAccess = await getFullAccess(admin, session);
  const locked = lockedKeysForPlan(fullAccess, shop.planCode);
  const locations = await loadStoreLocations(admin, shop.id);
  const { defaults } = currentDefaults(locations, await getStoredDefaults(shop.id));
  const selected = locations.filter((loc) => ids.includes(loc.id));
  return { shop, locked, locations, selected, defaults };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ids = readIds(new URL(request.url).searchParams.get("ids"));
  const { locked, selected, defaults } = await load(request, ids);
  return {
    locked,
    defaults,
    selected: selected.map((loc) => {
      const values = {} as LocationDefaults;
      for (const key of DEFAULTABLE_KEYS) values[key] = loc[key];
      return { id: loc.id, numericId: locationNumericId(loc.id), name: loc.displayName || loc.name, ...values };
    }),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const ids = readIds(typeof form.get("ids") === "string" ? (form.get("ids") as string) : null);
  const { shop, locked, locations, selected } = await load(request, ids);
  if (selected.length === 0) return { ok: false as const, error: "店が選ばれていません。店舗の一覧から選び直してください。" };
  const changes = readBulkForm(form);
  if (Object.keys(changes).length === 0) return { ok: false as const, error: "変える項目を 1 つ以上選んでください。" };
  const updates = planBulkChange(locations, selected.map((loc) => loc.id), changes, locked);
  try {
    await writeLocationUpdates(shop.id, locations, updates);
  } catch (error) {
    console.error("[settings/bulk] save failed", error);
    return { ok: false as const, error: "反映できませんでした。少し待ってからもう一度お試しください。" };
  }
  return { ok: true as const, changed: updates.length, at: Date.now() };
}

type Choice = "" | "on" | "off";

export default function StoreBulkPage() {
  const { locked, defaults, selected } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const search = useLocation().search || "";
  const backSearch = (() => {
    const params = new URLSearchParams(search);
    params.delete("ids");
    const s = params.toString();
    return s ? `?${s}` : "";
  })();
  const busy = navigation.state === "submitting";
  const [choices, setChoices] = useState<Partial<Record<DefaultableKey, Choice>>>({});
  const [confirming, setConfirming] = useState(false);

  const changes = useMemo(() => {
    const out: Partial<LocationDefaults> = {};
    for (const key of DEFAULTABLE_KEYS) {
      if (choices[key] === "on") out[key] = true;
      else if (choices[key] === "off") out[key] = false;
    }
    return out;
  }, [choices]);
  const updates = useMemo(() => planBulkChange(selected, selected.map((loc) => loc.id), changes, locked), [selected, changes, locked]);
  const changedKeys = Object.keys(changes) as DefaultableKey[];
  const names = selected.map((loc) => loc.name);

  return (
    <PolarisPageWrapper>
      <Page title="選んだ店をまとめて変更" backAction={{ content: "店舗", onAction: () => navigate("/app/settings" + backSearch) }}>
        <StoreBody>
        <SuccessToast trigger={result} message={result?.ok ? `${result.changed} 店を変更しました` : null} />
        {!busy && result && !result.ok ? <StatusBanner tone="critical" heading="反映できませんでした">{result.error}</StatusBanner> : null}
        {selected.length === 0 ? (
          <StatusBanner tone="warning" heading="店が選ばれていません">店舗の一覧で店を選んでから、「選んだ店をまとめて変更」を押してください。</StatusBanner>
        ) : (
          <Form method="post" onSubmit={() => setConfirming(false)}>
            <input type="hidden" name="ids" value={selected.map((loc) => loc.numericId).join(",")} />
            <AdminIntro>
              <p>
                {selected.length} 店を選んでいます: {names.slice(0, 8).join("・")}
                {names.length > 8 ? ` ほか ${names.length - 8} 店` : ""}。変える項目だけ選んでください。「変えない」の項目は今のままです。
              </p>
            </AdminIntro>
            {DEFAULT_GROUPS.map((group) => (
              <AdminBlock key={group.key} title={group.title} description={group.description}>
                {group.items.map((item) => {
                  const isLocked = locked.includes(item.key);
                  return (
                    <label key={item.key}>
                      {item.label}
                      {isLocked ? <span className="Admin-note">（プロプランで使えます）</span> : null}
                      <select
                        name={item.key}
                        value={choices[item.key] ?? ""}
                        disabled={isLocked}
                        onChange={(event) => {
                          const value = event.currentTarget.value as Choice;
                          setChoices((prev) => ({ ...prev, [item.key]: value }));
                          setConfirming(false);
                        }}
                      >
                        <option value="">変えない</option>
                        <option value="on">する{defaults[item.key] ? "（全店の決まりと同じ）" : ""}</option>
                        <option value="off">しない{defaults[item.key] ? "" : "（全店の決まりと同じ）"}</option>
                      </select>
                    </label>
                  );
                })}
              </AdminBlock>
            ))}
            <AdminBlock title="反映" description="反映した時点から、その店の POS と精算・売上サマリーに効きます。">
              {!confirming ? (
                <button type="button" className="Admin-primary" disabled={changedKeys.length === 0} onClick={() => setConfirming(true)}>
                  内容を確かめる
                </button>
              ) : (
                <div role="group" aria-label="反映の確認">
                  <p>
                    {updates.length === 0
                      ? "選んだ店はもうこの設定なので、変わる店はありません。"
                      : `${selected.length} 店のうち ${updates.length} 店が変わります。変える項目: ${changedKeys.map((key) => `${DEFAULTABLE_LABELS[key]}を${changes[key] ? "する" : "しない"}`).join("・")}`}
                  </p>
                  <p className="Admin-row-actions">
                    <button type="submit" className="Admin-primary" disabled={busy || updates.length === 0}>
                      {updates.length} 店に反映する
                    </button>
                    <button type="button" className="Admin-secondary" onClick={() => setConfirming(false)}>
                      やめる
                    </button>
                  </p>
                </div>
              )}
            </AdminBlock>
          </Form>
        )}
        </StoreBody>
      </Page>
    </PolarisPageWrapper>
  );
}
