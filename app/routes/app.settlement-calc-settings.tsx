/**
 * /app/settlement-calc-settings — 精算の数え方
 *
 * 店ごとに運用が違う所（売上を数える日・点数に数えない商品・返金の支払方法の変更・ギフトカードの返金など）を選ぶ。
 * 初めの値は今の数え方のまま。保存先は AppSetting の settlement_calc_settings（app/utils/settlementCalcSettings.ts）。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useSubmit, useLocation, useNavigate, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  TextField,
  Checkbox,
  Button,
  BlockStack,
  Banner,
  InlineStack,
  Select,
  ChoiceList,
  Text,
} from "@shopify/polaris";
import { DeleteIcon, PlusIcon } from "@shopify/polaris-icons";
import { useState } from "react";
import { SuccessToast, AdminIntro } from "../components/admin-ui";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import {
  getAppSetting,
  setAppSetting,
  SETTLEMENT_SETTINGS_KEY,
  DEFAULT_SETTLEMENT_SETTINGS,
  type SettlementSettings,
} from "../utils/appSettings.server";
import {
  SETTLEMENT_CALC_SETTINGS_KEY,
  REFUND_REMAP_RULES_MAX,
  resolveSettlementCalcSettings,
  validateSettlementCalcSettings,
  type RefundRemapRule,
  type SettlementCalcSettings,
} from "../utils/settlementCalcSettings";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, SETTLEMENT_TABS } from "../components/TabGroupBar";
import { loadPaymentKeyMasters } from "../utils/paymentMethod.server";
import { comparePaymentKeysForMasters } from "../services/paymentKeyMasterPure.server";

function locationNumericId(gid: string): string {
  const m = String(gid).match(/(\d+)$/);
  return m?.[1] ?? "";
}

async function loadLegacyGiftOn(shopId: string): Promise<boolean> {
  const saved = await getAppSetting<Partial<SettlementSettings>>(shopId, SETTLEMENT_SETTINGS_KEY);
  return { ...DEFAULT_SETTLEMENT_SETTINGS, ...saved }.legacyGiftCardAggregationEnabled === true;
}

async function loadLocations(shopId: string): Promise<{ id: string; name: string }[]> {
  const rows = await prisma.location.findMany({
    where: { shopId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { shopifyLocationGid: true, name: true, displayName: true },
  });
  return (rows as { shopifyLocationGid: string; name: string; displayName: string | null }[])
    .map((r) => ({ id: locationNumericId(r.shopifyLocationGid), name: r.displayName?.trim() || r.name }))
    .filter((r) => r.id !== "");
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const [saved, legacyGiftOn, locations, masters] = await Promise.all([
    getAppSetting<unknown>(shop.id, SETTLEMENT_CALC_SETTINGS_KEY),
    loadLegacyGiftOn(shop.id),
    loadLocations(shop.id),
    loadPaymentKeyMasters(shop.id),
  ]);
  // 「支払方法の分け方」を切り替えると行の名前が変わるマスタ（切り替える前に見る）
  const paymentKeyChanges = comparePaymentKeysForMasters(masters).filter((r) => r.changes);
  // 精算で今使っている値（壊れた値は初めの値）をそのまま見せる
  return {
    settings: resolveSettlementCalcSettings(saved),
    legacyGiftOn,
    locations,
    paymentKeyChanges,
    masterCount: masters.length,
    // 「支払方法マスタで分ける」ときの行の名前（返金の付け替え先がこの中にあるかを画面で見る）
    masterLabels: Array.from(
      new Set(masters.map((m) => String(m.displayLabel ?? "").trim()).filter((v) => v !== "")),
    ),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();

  let rules: unknown = [];
  try {
    rules = JSON.parse(String(formData.get("refundRemapRules") ?? "[]"));
  } catch {
    return Response.json(
      { ok: false, error: "「返金の支払方法の変更」を読み取れませんでした。画面を読み直してください。" },
      { status: 400 },
    );
  }

  const [legacyGiftOn, locations] = await Promise.all([loadLegacyGiftOn(shop.id), loadLocations(shop.id)]);
  const parsed = validateSettlementCalcSettings(
    {
      saleDateBasis: formData.get("saleDateBasis"),
      giftCardRefundEnabled: formData.get("giftCardRefundEnabled") === "true",
      giftCardRefundLabel: formData.get("giftCardRefundLabel"),
      itemCountExcludedSkus: String(formData.get("itemCountExcludedSkus") ?? ""),
      refundRemapRules: rules,
      paymentTxCountMode: formData.get("paymentTxCountMode"),
      clampTotalAtZero: formData.get("clampTotalAtZero") !== "false",
      paymentKeySource: formData.get("paymentKeySource") ?? undefined,
    },
    {
      legacyGiftCardAggregationEnabled: legacyGiftOn,
      knownLocationIds: new Set(locations.map((l) => l.id)),
    },
  );
  if (!parsed.ok) {
    return Response.json({ ok: false, error: parsed.error }, { status: 400 });
  }
  await setAppSetting(shop.id, SETTLEMENT_CALC_SETTINGS_KEY, parsed.settings);
  return Response.json({ ok: true, at: Date.now() });
}

export default function SettlementCalcSettingsPage() {
  const { settings: initial, legacyGiftOn, locations, paymentKeyChanges, masterCount, masterLabels } =
    useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const actionData = useActionData<{ ok: boolean; error?: string; at?: number }>();
  // 押してから終わるまで保存ボタンを処理中にし、二重に押せないようにする（UI ルール v1.1）
  const navigation = useNavigation();
  const saving = navigation.state !== "idle" && navigation.formMethod?.toLowerCase() === "post";

  const [form, setForm] = useState<SettlementCalcSettings>({ ...initial });
  const [skuText, setSkuText] = useState(initial.itemCountExcludedSkus.join("\n"));
  const [rules, setRules] = useState<RefundRemapRule[]>(initial.refundRemapRules.map((r) => ({ ...r })));

  const set = <K extends keyof SettlementCalcSettings>(key: K, value: SettlementCalcSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };
  const setRule = (index: number, patch: Partial<RefundRemapRule>) => {
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const handleSave = () => {
    const fd = new FormData();
    fd.set("saleDateBasis", form.saleDateBasis);
    fd.set("giftCardRefundEnabled", form.giftCardRefundEnabled ? "true" : "false");
    fd.set("giftCardRefundLabel", form.giftCardRefundLabel);
    fd.set("itemCountExcludedSkus", skuText);
    fd.set("refundRemapRules", JSON.stringify(rules));
    fd.set("paymentTxCountMode", form.paymentTxCountMode);
    fd.set("clampTotalAtZero", form.clampTotalAtZero ? "true" : "false");
    fd.set("paymentKeySource", form.paymentKeySource);
    submit(fd, { method: "post" });
  };

  const locationOptions = [
    { label: "すべての店", value: "" },
    ...locations.map((l) => ({ label: l.name, value: l.id })),
  ];

  return (
    <PolarisPageWrapper>
      <Page
        title="精算の数え方"
        backAction={{ content: "精算設定", onAction: () => navigate("/app/settlement-settings" + q) }}
        primaryAction={{
          content: saving ? "処理中…" : "保存",
          onAction: handleSave,
          loading: saving,
          disabled: saving,
        }}
      >
        <BlockStack gap="400">
          <TabGroupBar tabs={SETTLEMENT_TABS} />
          <Layout>
            {/* 保存の成功はトーストで出し、保存のたびに出す（UI ルール v1.1 7章） */}
            <SuccessToast message={actionData?.ok ? "保存しました" : null} trigger={actionData} />
            {actionData?.ok === false && actionData.error && (
              <Layout.Section>
                <Banner tone="critical">保存していません。{actionData.error}</Banner>
              </Layout.Section>
            )}

            <Layout.Section>
              <AdminIntro>
                <p>店ごとに運用が違う所の数え方を選びます。初めの値のままなら、精算と売上サマリーの数字は今と変わりません。</p>
              </AdminIntro>
            </Layout.Section>

            <Layout.AnnotatedSection
              title="売上を数える日"
              description="決済が日をまたぐ注文（後日の入金・オーソリのあとの確定など）を、どの日の売上にするかを選びます。"
            >
              <Card>
                <ChoiceList
                  title="売上を数える日"
                  titleHidden
                  choices={[
                    { label: "決済した日", value: "transaction", helpText: "決済の時刻の日に数えます。" },
                    {
                      label: "注文の日",
                      value: "order",
                      helpText: "決済がまだ確定していない注文は、オーソリの額を注文の日の売上に数えます。",
                    },
                  ]}
                  selected={[form.saleDateBasis]}
                  onChange={(v) => set("saleDateBasis", (v[0] as SettlementCalcSettings["saleDateBasis"]) ?? "transaction")}
                />
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="支払方法の分け方"
              description="精算と売上サマリーで、取引をどの支払方法の行に入れるかの決め方です。"
            >
              <Card>
                <BlockStack gap="300">
                  <ChoiceList
                    title="支払方法の分け方"
                    titleHidden
                    choices={[
                      {
                        label: "決まった分け方",
                        value: "builtin",
                        helpText: "決済の名前から、現金・クレジットカード・電子マネー・交通系 IC・商品券などに分けます。",
                      },
                      {
                        label: "支払方法マスタで分ける",
                        value: "master",
                        helpText:
                          "支払方法マスタの上から順に見て、当てはまった支払方法の表示名の行に入れます。どれにも当てはまらない取引は決まった分け方の行に入れます。",
                      },
                    ]}
                    selected={[form.paymentKeySource]}
                    onChange={(v) =>
                      set("paymentKeySource", (v[0] as SettlementCalcSettings["paymentKeySource"]) ?? "builtin")
                    }
                  />
                  {form.paymentKeySource === "master" && (
                    <BlockStack gap="200">
                      {masterCount === 0 ? (
                        <Text as="p" variant="bodySm" tone="caution">
                          支払方法マスタがまだありません。すべての取引が決まった分け方の行に入ります。
                        </Text>
                      ) : paymentKeyChanges.length === 0 ? (
                        <Text as="p" variant="bodySm" tone="subdued">
                          登録した支払方法では、行の名前は今と変わりません。
                        </Text>
                      ) : (
                        <>
                          <Text as="p" variant="bodySm" tone="caution">
                            保存すると、次の支払方法の行の名前が変わります。確定済みの精算は変わりません。
                            変えた日の前後で同じ支払方法が 2 つの名前に分かれる（照合用 CSV・ほかの集計との比べ）ので、切り替えは月の始めにしてください。
                          </Text>
                          {paymentKeyChanges.map((r) => (
                            <Text as="p" variant="bodySm" key={r.rawGatewayPattern}>
                              {r.rawGatewayPattern}: {r.builtinKey} → {r.masterKey}
                            </Text>
                          ))}
                        </>
                      )}
                      <Text as="p" variant="bodySm" tone="subdued">
                        現金の上限（おつりを売上に入れない）は種類が「現金」のマスタに、商品券のおつりの観測は「商品券として扱う」マスタに効きます。
                      </Text>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="点数に数えない商品"
              description="ノベルティなど 0 円で配る商品を、精算の点数に入れないようにします。"
            >
              <Card>
                <TextField
                  label="SKU（1 行に 1 つ）"
                  value={skuText}
                  onChange={setSkuText}
                  multiline={4}
                  helpText="この SKU の 0 円の明細だけを点数から外します。値段を付けて売った明細は数えます。大文字と小文字は区別しません。"
                  autoComplete="off"
                />
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="返金の支払方法の変更"
              description="返金を元の支払方法と違う方法で払い出す店で、精算の返金を払い出した方法に載せます（例: ある店では wespo の返金を現金で返す）。"
            >
              <Card>
                <BlockStack gap="300">
                  {(() => {
                    // マスタで分ける店では、行の名前はマスタの表示名。付け替え先がそれと違うと、
                    // 付け替えた返金が別の行になり、現金の上限・納金額とずれる（#82 の見直し P2）
                    if (form.paymentKeySource !== "master" || masterLabels.length === 0) return null;
                    const known = new Set(masterLabels);
                    const unknown = Array.from(
                      new Set(rules.map((r) => r.toLabel.trim()).filter((v) => v !== "" && !known.has(v))),
                    );
                    if (unknown.length === 0) return null;
                    return (
                      <Text as="p" variant="bodySm" tone="caution">
                        付け替え先「{unknown.join("」「")}」は支払方法マスタの表示名にありません。マスタで分けるときは、付け替え先をマスタの表示名（{masterLabels.join("・")}）にしてください。
                      </Text>
                    );
                  })()}
                  {rules.length === 0 ? (
                    <Text as="p" tone="subdued">変更はありません。</Text>
                  ) : (
                    rules.map((rule, index) => (
                      <InlineStack key={index} gap="200" align="start" blockAlign="end" wrap>
                        <div style={{ flex: "1 1 160px", minWidth: 0 }}>
                          <TextField
                            label="支払方法に含まれる文字"
                            value={rule.match}
                            onChange={(v) => setRule(index, { match: v })}
                            autoComplete="off"
                          />
                        </div>
                        <div style={{ flex: "1 1 140px", minWidth: 0 }}>
                          <TextField
                            label="変更後"
                            value={rule.toLabel}
                            onChange={(v) => setRule(index, { toLabel: v })}
                            placeholder="現金"
                            autoComplete="off"
                          />
                        </div>
                        <div style={{ flex: "1 1 160px", minWidth: 0 }}>
                          <Select
                            label="店"
                            options={locationOptions}
                            value={rule.locationId}
                            onChange={(v) => setRule(index, { locationId: v })}
                          />
                        </div>
                        <Button
                          icon={DeleteIcon}
                          variant="tertiary"
                          accessibilityLabel={`${index + 1} 行目を消す`}
                          onClick={() => setRules((prev) => prev.filter((_, i) => i !== index))}
                        />
                      </InlineStack>
                    ))
                  )}
                  <InlineStack>
                    <Button
                      icon={PlusIcon}
                      disabled={rules.length >= REFUND_REMAP_RULES_MAX}
                      onClick={() => setRules((prev) => [...prev, { match: "", toLabel: "現金", locationId: "" }])}
                    >
                      変更を追加
                    </Button>
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    上から順に見て、最初に当てはまった行を使います。返金だけを変更し、売上は元の支払方法のままです。
                  </Text>
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="ギフトカードの返金"
              description="返品でお金の代わりにギフトカードを渡す店で、その額を精算の返金として引きます。"
            >
              <Card>
                <BlockStack gap="300">
                  <Checkbox
                    label="ギフトカードで払い出した返金を数える"
                    checked={form.giftCardRefundEnabled}
                    onChange={(v) => set("giftCardRefundEnabled", v)}
                    helpText="ギフトカードのメモに REFUND_CASH か REFUND_GC と「LOC:店の名前」があるカードを、その日の返金に足します。"
                  />
                  {legacyGiftOn && (
                    <Text as="p" variant="bodySm" tone="caution">
                      精算設定の「旧ギフトカード API 集計」が ON のあいだは使えません（返金のカードが売上にも数えられて二重になるため）。
                    </Text>
                  )}
                  <TextField
                    label="返金を載せる支払方法"
                    value={form.giftCardRefundLabel}
                    onChange={(v) => set("giftCardRefundLabel", v)}
                    helpText="精算の支払方法の名前（初めは 現金）"
                    autoComplete="off"
                    disabled={!form.giftCardRefundEnabled}
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="支払方法ごとの取引件数"
              description="精算の支払方法ごとに出す件数の数え方です。"
            >
              <Card>
                <ChoiceList
                  title="支払方法ごとの取引件数"
                  titleHidden
                  choices={[
                    { label: "売上の取引の件数", value: "sales" },
                    { label: "売上の取引の件数から返金の件数を引く", value: "sales_minus_refunds" },
                  ]}
                  selected={[form.paymentTxCountMode]}
                  onChange={(v) =>
                    set("paymentTxCountMode", (v[0] as SettlementCalcSettings["paymentTxCountMode"]) ?? "sales")
                  }
                />
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="返金が売上より多い日"
              description="その日の返金が売上より多いときの合計の出し方です。"
            >
              <Card>
                <Checkbox
                  label="合計をマイナスにしない（0 円にする）"
                  checked={form.clampTotalAtZero}
                  onChange={(v) => set("clampTotalAtZero", v)}
                  helpText="外すと、合計・純売上・税をマイナスのまま出します。"
                />
              </Card>
            </Layout.AnnotatedSection>
          </Layout>
        </BlockStack>
      </Page>
    </PolarisPageWrapper>
  );
}
