/**
 * /app/settings/store/:id — 店ごとの編集（個店調整）
 *
 * 全店の決まりと違う項目には「全店と違う」が付く。「全店と同じに戻す」でその店の変更を消せる（保存で反映）。
 * 書くのはこの店の Location の列だけ（精算・売上サマリーが読む値。読む側は変えない）。
 */
import { useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useLocation, useNavigate, useNavigation } from "react-router";
import { Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getFullAccess } from "../utils/planFeatures.server";
import { currentDefaults, getStoredDefaults, loadStoreLocations, lockedKeysForPlan } from "../utils/locationDefaults.server";
import {
  DEFAULTABLE_KEYS,
  DEFAULT_GROUPS,
  differingKeys,
  locationGidFromNumeric,
  resetToDefaults,
  type LocationDefaults,
} from "../utils/locationDefaults";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { StoreBody } from "../components/StoreBody";
import { AdminBlock, SaveBar, StateBadge, StatusBanner, SuccessToast, markFormDirty } from "../components/admin-ui";
import { withSearch } from "../utils/withSearch";

async function load(request: Request, id: string | undefined) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const gid = locationGidFromNumeric(id ?? "");
  if (!gid) throw new Response("店が見つかりません", { status: 404 });
  const fullAccess = await getFullAccess(admin, session);
  const locked = lockedKeysForPlan(fullAccess, shop.planCode);
  const locations = await loadStoreLocations(admin, shop.id);
  const location = locations.find((loc) => loc.id === gid);
  if (!location) throw new Response("店が見つかりません", { status: 404 });
  const { defaults } = currentDefaults(locations, await getStoredDefaults(shop.id));
  return { shop, locked, locations, location, defaults };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { locked, locations, location, defaults } = await load(request, params.id);
  const other = locations.find((loc) => loc.id !== location.id && loc.nonPosRefundAttributionEnabled);
  return { location, defaults, locked, nonPosOther: other ? other.displayName || other.name : null };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { shop, locked, location } = await load(request, params.id);
  const form = await request.formData();
  const text = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const sortText = text("sortOrder") ?? "0";
  if (!/^-?\d{1,6}$/.test(sortText)) return { ok: false as const, error: "並び順は数字で入れてください。" };
  const values: Partial<LocationDefaults> = {};
  for (const key of DEFAULTABLE_KEYS) values[key] = locked.includes(key) ? location[key] : form.get(key) === "on";
  const nonPos = form.get("nonPosRefundAttributionEnabled") === "on";
  const data = {
    displayName: text("displayName"),
    shortName: text("shortName"),
    sortOrder: Number(sortText),
    // 印字はいつも POS につないだプリンタへ送る（#22）。前の印字のしかたの値はそのまま残し、ここでは書き換えない
    printerProfileId: text("printerProfileId"),
    summaryTargetGroup: text("summaryTargetGroup"),
    nonPosRefundAttributionEnabled: nonPos,
    ...values,
  };
  try {
    await prisma.$transaction([
      // 管理画面からの返金の計上先はショップで 1 店だけ（今までの店舗の画面と同じ）
      ...(nonPos
        ? [prisma.location.updateMany({ where: { shopId: shop.id, shopifyLocationGid: { not: location.id } }, data: { nonPosRefundAttributionEnabled: false } })]
        : []),
      prisma.location.upsert({
        where: { shopId_shopifyLocationGid: { shopId: shop.id, shopifyLocationGid: location.id } },
        update: data,
        create: { shopId: shop.id, shopifyLocationGid: location.id, name: location.name, ...data },
      }),
    ]);
  } catch (error) {
    console.error("[settings/store] save failed", error);
    return { ok: false as const, error: "保存できませんでした。少し待ってからもう一度保存してください。" };
  }
  // 売上サマリーをオンにしたら、当月分を裏で数え始める（POS で初めて開いたときに待たせない）
  if (values.salesSummaryEnabled === true && !location.salesSummaryEnabled) {
    const { enqueueSalesSummaryFillForTurnedOn } = await import("../services/salesSummaryFillQueue.server");
    void enqueueSalesSummaryFillForTurnedOn(shop.id, [{ shopifyLocationGid: location.id, name: location.name }]);
  }
  return { ok: true as const, at: Date.now() };
}

export default function StoreEditPage() {
  const { location, defaults, locked, nonPosOther } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const q = useLocation().search || "";
  const busy = navigation.state === "submitting";
  const initial = {} as LocationDefaults;
  for (const key of DEFAULTABLE_KEYS) initial[key] = location[key];
  const [values, setValues] = useState<LocationDefaults>(initial);
  const formRef = useRef<HTMLFormElement | null>(null);
  const differing = differingKeys(values, defaults);
  const name = location.displayName || location.name;

  const resetGroup = (groupKeys: string[]) => {
    const reset = resetToDefaults(values, defaults, locked);
    const next = { ...values };
    for (const key of DEFAULTABLE_KEYS) if (groupKeys.includes(key) && key in reset) next[key] = reset[key] as boolean;
    setValues(next);
    // 状態で持つ欄を書き換えたので、保存の帯に知らせる（描き直しのあとで比べる）
    window.requestAnimationFrame(() => markFormDirty(formRef.current));
  };

  return (
    <PolarisPageWrapper>
      <Page
        title={name}
        subtitle={differing.length > 0 ? `全店と違う ${differing.length} 項目` : "全店と同じ"}
        backAction={{ content: "店舗", onAction: () => navigate(withSearch("/app/settings", q)) }}
      >
        <StoreBody>
        <SuccessToast trigger={result} message={result?.ok ? "保存しました" : null} />
        {!busy && result && !result.ok ? <StatusBanner tone="critical" heading="保存できませんでした">{result.error}</StatusBanner> : null}
        <Form method="post" ref={formRef}>
          <AdminBlock title="店の名前" description="レシートと管理画面に出る名前です。空なら Shopify の名前を使います。">
            <label>
              表示名
              <input name="displayName" defaultValue={location.displayName ?? ""} placeholder={location.name} maxLength={100} autoComplete="off" />
            </label>
            <label>
              短い名前
              <input name="shortName" defaultValue={location.shortName ?? ""} placeholder="例: 本店" maxLength={30} autoComplete="off" />
            </label>
            <label>
              並び順（小さいほど上）
              <input name="sortOrder" type="number" inputMode="numeric" defaultValue={String(location.sortOrder)} />
            </label>
          </AdminBlock>

          {DEFAULT_GROUPS.map((group) => {
            const keys = group.items.map((item) => item.key as string);
            const groupDiffers = differing.some((key) => keys.includes(key));
            return (
              <AdminBlock
                key={group.key}
                title={group.title}
                description={group.description}
                action={groupDiffers ? (
                  <button type="button" className="Admin-secondary Admin-button-sm" onClick={() => resetGroup(keys)}>全店と同じに戻す</button>
                ) : null}
              >
                {group.items.map((item) => {
                  const isLocked = locked.includes(item.key);
                  return (
                    <label key={item.key}>
                      <input
                        type="checkbox"
                        name={item.key}
                        checked={values[item.key]}
                        disabled={isLocked}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setValues((prev) => ({ ...prev, [item.key]: checked }));
                        }}
                      />
                      <span>
                        {item.label}{" "}
                        {values[item.key] !== defaults[item.key] ? <StateBadge label="全店と違う" tone="info" /> : null}
                        {isLocked ? <span className="Admin-note">（プロプランで使えます）</span> : null}
                      </span>
                    </label>
                  );
                })}
              </AdminBlock>
            );
          })}

          <AdminBlock title="印字" description="この店のレシートは、POS につないだプリンタで印刷します。">
            <p className="Admin-note">印刷: POS につないだプリンタへ送ります。</p>
            <label>
              プリンタの設定の名前（任意）
              <input name="printerProfileId" defaultValue={location.printerProfileId ?? ""} maxLength={100} autoComplete="off" />
            </label>
          </AdminBlock>

          <AdminBlock title="そのほか" description="この店だけに決める項目です。">
            <label>
              <input type="checkbox" name="nonPosRefundAttributionEnabled" defaultChecked={location.nonPosRefundAttributionEnabled} />
              <span>
                管理画面からの返金を、この店の精算に入れる
                <span className="Admin-note" style={{ display: "block" }}>
                  POS を通さない返金（Shopify の管理画面からの返金など）を入れる店です。1 店だけ選べます。
                  {nonPosOther ? `今は「${nonPosOther}」です。ここをオンにして保存すると、この店に移ります。` : ""}
                </span>
              </span>
            </label>
            <label>
              売上サマリーのグループ名（任意）
              <input name="summaryTargetGroup" defaultValue={location.summaryTargetGroup ?? ""} maxLength={50} autoComplete="off" />
            </label>
          </AdminBlock>
          <SaveBar failed={!busy && Boolean(result && !result.ok)} onDiscard={() => setValues(initial)} />
        </Form>
        </StoreBody>
      </Page>
    </PolarisPageWrapper>
  );
}
