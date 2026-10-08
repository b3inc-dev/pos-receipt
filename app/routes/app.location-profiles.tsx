/**
 * /app/location-profiles — 設定軸（プロファイル）＋複数ロケ一括反映＋コピー＋差分プレビュー
 * 第一弾: Location の機能フラグ・集計・印字関連・summaryTargetGroup 等
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useLocation, useNavigate, useRevalidator } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  TextField,
  Button,
  BlockStack,
  Banner,
  InlineStack,
  Select,
  Checkbox,
  Divider,
  Box,
  DataTable,
} from "@shopify/polaris";
import { useMemo, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getAppSetting, setAppSetting } from "../utils/appSettings.server";
import {
  LOCATION_PROFILES_KEY,
  DEFAULT_LOCATION_PROFILES,
  LOCATION_PROFILE_FIELD_KEYS,
  type LocationProfilesState,
  type LocationSettingProfile,
  type LocationProfileFields,
} from "../utils/locationProfiles";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, STORE_TABS } from "../components/TabGroupBar";

type LocRow = {
  id: string; // shopify GID
  name: string;
  displayName: string | null;
  fields: LocationProfileFields;
};

const FIELD_LABELS: Record<keyof LocationProfileFields, string> = {
  printMode: "印字方式（printMode）",
  salesSummaryEnabled: "売上サマリー",
  settlementEnabled: "精算",
  receiptEnabled: "領収書",
  specialRefundEnabled: "特殊返金",
  voucherAdjustmentEnabled: "商品券調整",
  inspectionReceiptEnabled: "点検レシート",
  includeInStoreTotals: "店舗合計に含める",
  includeInOverallTotals: "全体合計に含める",
  visibleInSummaryDefault: "サマリー既定表示",
  printerProfileId: "プリンタプロファイル",
  cloudprntEnabled: "CloudPRNT",
  summaryTargetGroup: "サマリー対象グループ",
  budgetTargetEnabled: "予算対象",
  footfallTargetEnabled: "入店数対象",
};

function formatFieldValue(key: keyof LocationProfileFields, value: unknown): string {
  if (key === "printMode") {
    if (value === "order_based") return "注文経由（order_based）";
    if (value === "cloudprnt_direct") return "CloudPRNT 直印字";
  }
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "ON" : "OFF";
  return String(value);
}

function pickFields(loc: Record<string, unknown>): LocationProfileFields {
  const out: LocationProfileFields = {};
  for (const k of LOCATION_PROFILE_FIELD_KEYS) {
    if (k in loc) (out as Record<string, unknown>)[k] = loc[k];
  }
  return out;
}

function diffFields(
  current: LocationProfileFields,
  incoming: LocationProfileFields,
): { key: keyof LocationProfileFields; from: unknown; to: unknown }[] {
  const diffs: { key: keyof LocationProfileFields; from: unknown; to: unknown }[] = [];
  for (const k of LOCATION_PROFILE_FIELD_KEYS) {
    if (!(k in incoming)) continue;
    const from = current[k];
    const to = incoming[k];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      diffs.push({ key: k, from, to });
    }
  }
  return diffs;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const locRes = await admin.graphql(`#graphql
    query Locations {
      locations(first: 50, includeLegacy: false) {
        nodes { id name isActive }
      }
    }
  `);
  const locJson = (await locRes.json()) as {
    data?: { locations?: { nodes?: { id: string; name: string; isActive: boolean }[] } };
  };
  const shopifyLocations = (locJson.data?.locations?.nodes ?? []).filter((l) => l.isActive);
  const dbLocations = await prisma.location.findMany({ where: { shopId: shop.id } });
  const dbMap = new Map(dbLocations.map((l) => [l.shopifyLocationGid, l]));

  const locations: LocRow[] = shopifyLocations.map((sl) => {
    const db = dbMap.get(sl.id);
    const raw = {
      printMode: db?.printMode ?? "order_based",
      salesSummaryEnabled: db?.salesSummaryEnabled ?? false,
      settlementEnabled: db?.settlementEnabled ?? true,
      receiptEnabled: db?.receiptEnabled ?? true,
      specialRefundEnabled: db?.specialRefundEnabled ?? true,
      voucherAdjustmentEnabled: db?.voucherAdjustmentEnabled ?? true,
      inspectionReceiptEnabled: db?.inspectionReceiptEnabled ?? true,
      includeInStoreTotals: db?.includeInStoreTotals ?? true,
      includeInOverallTotals: db?.includeInOverallTotals ?? true,
      visibleInSummaryDefault: db?.visibleInSummaryDefault ?? true,
      printerProfileId: db?.printerProfileId ?? null,
      cloudprntEnabled: db?.cloudprntEnabled ?? false,
      summaryTargetGroup: db?.summaryTargetGroup ?? null,
      budgetTargetEnabled: db?.budgetTargetEnabled ?? false,
      footfallTargetEnabled: db?.footfallTargetEnabled ?? false,
    };
    return {
      id: sl.id,
      name: sl.name,
      displayName: db?.displayName ?? null,
      fields: pickFields(raw),
    };
  });

  const profilesState =
    (await getAppSetting<LocationProfilesState>(shop.id, LOCATION_PROFILES_KEY)) ??
    DEFAULT_LOCATION_PROFILES;

  return { locations, profiles: profilesState.profiles };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "save_profile") {
    const id = String(formData.get("profileId") || crypto.randomUUID());
    const name = String(formData.get("name") || "無名プロファイル").trim();
    const fieldsJson = String(formData.get("fieldsJson") || "{}");
    const fields = JSON.parse(fieldsJson) as LocationProfileFields;
    const state =
      (await getAppSetting<LocationProfilesState>(shop.id, LOCATION_PROFILES_KEY)) ??
      DEFAULT_LOCATION_PROFILES;
    const next: LocationSettingProfile = {
      id,
      name,
      fields,
      updatedAt: new Date().toISOString(),
    };
    const profiles = [...state.profiles.filter((p) => p.id !== id), next];
    await setAppSetting(shop.id, LOCATION_PROFILES_KEY, { profiles });
    return Response.json({ ok: true, profile: next });
  }

  if (intent === "delete_profile") {
    const id = String(formData.get("profileId") || "");
    const state =
      (await getAppSetting<LocationProfilesState>(shop.id, LOCATION_PROFILES_KEY)) ??
      DEFAULT_LOCATION_PROFILES;
    await setAppSetting(shop.id, LOCATION_PROFILES_KEY, {
      profiles: state.profiles.filter((p) => p.id !== id),
    });
    return Response.json({ ok: true });
  }

  if (intent === "apply") {
    const fields = JSON.parse(String(formData.get("fieldsJson") || "{}")) as LocationProfileFields;
    const targetIds = JSON.parse(String(formData.get("targetIdsJson") || "[]")) as string[];
    const confirm = formData.get("confirm") === "true";
    if (!confirm) {
      return Response.json({ ok: false, error: "confirm required" }, { status: 400 });
    }

    for (const gid of targetIds) {
      const existing = await prisma.location.findFirst({
        where: { shopId: shop.id, shopifyLocationGid: gid },
      });
      const data: Record<string, unknown> = {};
      for (const k of LOCATION_PROFILE_FIELD_KEYS) {
        if (k in fields) data[k] = fields[k];
      }
      if (!existing) {
        const nameFromShopify = String(formData.get(`name_${gid}`) || gid);
        await prisma.location.create({
          data: {
            shopId: shop.id,
            shopifyLocationGid: gid,
            name: nameFromShopify,
            ...(data as object),
          },
        });
      } else {
        await prisma.location.update({
          where: { id: existing.id },
          data: data as object,
        });
      }
    }
    return Response.json({ ok: true, applied: targetIds.length });
  }

  return Response.json({ ok: false, error: "unknown intent" }, { status: 400 });
}

export default function LocationProfilesPage() {
  const { locations, profiles } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";

  const [profileName, setProfileName] = useState("標準店舗");
  const [sourceLocId, setSourceLocId] = useState(locations[0]?.id ?? "");
  const [selectedProfileId, setSelectedProfileId] = useState(profiles[0]?.id ?? "");
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [mode, setMode] = useState<"profile" | "copy">("copy");
  const [message, setMessage] = useState("");

  const sourceFields = useMemo(() => {
    if (mode === "profile") {
      return profiles.find((p) => p.id === selectedProfileId)?.fields ?? {};
    }
    return locations.find((l) => l.id === sourceLocId)?.fields ?? {};
  }, [mode, profiles, selectedProfileId, locations, sourceLocId]);

  const previewRows = useMemo(() => {
    const rows: string[][] = [];
    for (const loc of locations.filter((l) => targetIds.includes(l.id))) {
      const diffs = diffFields(loc.fields, sourceFields);
      if (diffs.length === 0) {
        rows.push([loc.displayName || loc.name, "（差分なし）", "", ""]);
        continue;
      }
      for (const d of diffs) {
        rows.push([
          loc.displayName || loc.name,
          FIELD_LABELS[d.key] || d.key,
          formatFieldValue(d.key, d.from),
          formatFieldValue(d.key, d.to),
        ]);
      }
    }
    return rows;
  }, [locations, targetIds, sourceFields]);

  const changingFieldSummary = useMemo(() => {
    const keys = new Set<keyof LocationProfileFields>();
    for (const loc of locations.filter((l) => targetIds.includes(l.id))) {
      for (const d of diffFields(loc.fields, sourceFields)) keys.add(d.key);
    }
    return [...keys];
  }, [locations, targetIds, sourceFields]);

  const toggleTarget = (id: string) => {
    setTargetIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const saveProfileFromSource = () => {
    const fd = new FormData();
    fd.set("intent", "save_profile");
    fd.set("profileId", selectedProfileId || crypto.randomUUID());
    fd.set("name", profileName);
    fd.set("fieldsJson", JSON.stringify(sourceFields));
    fetcher.submit(fd, { method: "post" });
    setMessage("プロファイルを保存しました");
    setTimeout(() => revalidator.revalidate(), 400);
  };

  const apply = () => {
    if (targetIds.length === 0) {
      setMessage("対象ロケーションを選んでください");
      return;
    }
    const fieldList =
      changingFieldSummary.length > 0
        ? changingFieldSummary.map((k) => FIELD_LABELS[k] || k).join("、")
        : "（差分なし）";
    const printModeNote = changingFieldSummary.includes("printMode")
      ? "\n※ 印字方式（printMode）も上書きされます。"
      : "";
    if (
      !window.confirm(
        `${targetIds.length} 件のロケーションに上書き適用します。\n変更フィールド: ${fieldList}${printModeNote}\nよろしいですか？`,
      )
    ) {
      return;
    }
    const fd = new FormData();
    fd.set("intent", "apply");
    fd.set("confirm", "true");
    fd.set("fieldsJson", JSON.stringify(sourceFields));
    fd.set("targetIdsJson", JSON.stringify(targetIds));
    for (const loc of locations) {
      fd.set(`name_${loc.id}`, loc.name);
    }
    fetcher.submit(fd, { method: "post" });
    setMessage("一括反映を実行しました");
    setTimeout(() => revalidator.revalidate(), 500);
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="設定軸・一括反映"
        backAction={{ content: "ホーム", onAction: () => navigate("/app" + q) }}
      >
        <Card padding="0">
          <TabGroupBar tabs={STORE_TABS} />
        </Card>
        <Layout>
          <Layout.Section>
            <Banner tone="info">
              設定軸（プロファイル）または「このロケをコピー」で複数ロケーションへ反映できます。適用前に差分プレビューを確認してください。印字方式（printMode）を含む全フィールドが一括上書き対象です。個別ロケ編集は「ロケーション」タブに残しています。
            </Banner>
          </Layout.Section>
          {message ? (
            <Layout.Section>
              <Banner tone="success" onDismiss={() => setMessage("")}>
                {message}
              </Banner>
            </Layout.Section>
          ) : null}

          <Layout.AnnotatedSection title="ソース" description="適用元">
            <Card>
              <BlockStack gap="400">
                <Select
                  label="モード"
                  options={[
                    { label: "このロケをコピー", value: "copy" },
                    { label: "設定軸（プロファイル）", value: "profile" },
                  ]}
                  value={mode}
                  onChange={(v) => setMode(v as "profile" | "copy")}
                />
                {mode === "copy" ? (
                  <Select
                    label="コピー元ロケーション"
                    options={locations.map((l) => ({
                      label: l.displayName || l.name,
                      value: l.id,
                    }))}
                    value={sourceLocId}
                    onChange={setSourceLocId}
                  />
                ) : (
                  <BlockStack gap="300">
                    <Select
                      label="プロファイル"
                      options={[
                        { label: "（新規）", value: "" },
                        ...profiles.map((p) => ({ label: p.name, value: p.id })),
                      ]}
                      value={selectedProfileId}
                      onChange={setSelectedProfileId}
                    />
                    <TextField
                      label="プロファイル名"
                      value={profileName}
                      onChange={setProfileName}
                      autoComplete="off"
                    />
                    <InlineStack gap="200">
                      <Button onClick={saveProfileFromSource}>現在のソース内容で保存</Button>
                      {selectedProfileId ? (
                        <Button
                          tone="critical"
                          onClick={() => {
                            const fd = new FormData();
                            fd.set("intent", "delete_profile");
                            fd.set("profileId", selectedProfileId);
                            fetcher.submit(fd, { method: "post" });
                            setSelectedProfileId("");
                            setTimeout(() => revalidator.revalidate(), 400);
                          }}
                        >
                          削除
                        </Button>
                      ) : null}
                    </InlineStack>
                    <Text as="p" tone="subdued">
                      ヒント: 先に「このロケをコピー」で内容を確認し、プロファイルとして保存できます。
                    </Text>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="対象ロケーション" description="複数選択">
            <Card>
              <BlockStack gap="200">
                <InlineStack gap="200">
                  <Button onClick={() => setTargetIds(locations.map((l) => l.id))}>全選択</Button>
                  <Button onClick={() => setTargetIds([])}>クリア</Button>
                </InlineStack>
                <Divider />
                {locations.map((l) => (
                  <Checkbox
                    key={l.id}
                    label={l.displayName || l.name}
                    checked={targetIds.includes(l.id)}
                    onChange={() => toggleTarget(l.id)}
                  />
                ))}
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  差分プレビュー
                </Text>
                {targetIds.length === 0 ? (
                  <Text as="p" tone="subdued">
                    対象を選択すると差分が表示されます。
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    <Text as="p" tone="subdued">
                      変更されるフィールド:{" "}
                      {changingFieldSummary.length > 0
                        ? changingFieldSummary.map((k) => FIELD_LABELS[k] || k).join("、")
                        : "なし"}
                      {changingFieldSummary.includes("printMode")
                        ? "（※ 印字方式 printMode を含みます）"
                        : ""}
                    </Text>
                    <Box overflowX="scroll">
                      <DataTable
                        columnContentTypes={["text", "text", "text", "text"]}
                        headings={["ロケーション", "項目", "現在", "適用後"]}
                        rows={previewRows}
                      />
                    </Box>
                  </BlockStack>
                )}
                <InlineStack align="end">
                  <Button
                    variant="primary"
                    onClick={apply}
                    loading={fetcher.state !== "idle"}
                    disabled={targetIds.length === 0}
                  >
                    一括反映（上書き）
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
