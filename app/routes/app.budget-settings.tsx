/**
 * /app/budget-settings — 予算設定（要件 §11）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useSubmit, useLocation } from "react-router";
import { SuccessToast, AdminIntro, useGuardedNavigate } from "../components/admin-ui";
import { StateSaveForm } from "../components/StateSaveForm";
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
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import {
  getAppSetting,
  setAppSetting,
  BUDGET_SETTINGS_KEY,
  DEFAULT_BUDGET_SETTINGS,
  type BudgetSettings,
} from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, REPORTS_TABS } from "../components/TabGroupBar";

const INPUT_UNIT_OPTIONS = [
  { label: "日別", value: "daily" },
  { label: "月別", value: "monthly" },
];
const APPLY_MODE_OPTIONS = [
  { label: "日別厳格（日ごと入力）", value: "strict_daily" },
  { label: "月別から展開", value: "expand_from_monthly" },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const saved = await getAppSetting<Partial<BudgetSettings>>(shop.id, BUDGET_SETTINGS_KEY);
  const settings: BudgetSettings = { ...DEFAULT_BUDGET_SETTINGS, ...saved };
  return { settings };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const get = (k: string) => formData.get(k);
  const bool = (k: string, def: boolean) => get(k) === "true" || (def && get(k) !== "false");
  const settings: BudgetSettings = {
    ...DEFAULT_BUDGET_SETTINGS,
    csvColumnMappingEnabled: bool("csvColumnMappingEnabled", false),
    manualBudgetEditEnabled: bool("manualBudgetEditEnabled", true),
    bulkEditEnabled: bool("bulkEditEnabled", true),
    budgetInputUnit: (get("budgetInputUnit") as BudgetSettings["budgetInputUnit"]) || "daily",
    budgetApplyMode: (get("budgetApplyMode") as BudgetSettings["budgetApplyMode"]) || "strict_daily",
  };
  await setAppSetting(shop.id, BUDGET_SETTINGS_KEY, settings);
  return Response.json({ ok: true });
}

export default function BudgetSettingsPage() {
  const { settings: initial } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const actionData = useActionData<{ ok?: boolean }>();
  const location = useLocation();
  // 「←」とタブは、未保存の変更があれば Shopify の確認を出してから移る（UI ルール v1.1 7章）
  const navigate = useGuardedNavigate();
  const q = location.search || "";
  const [form, setForm] = useState<BudgetSettings>({ ...initial });

  const handleSave = () => {
    const fd = new FormData();
    Object.entries(form).forEach(([k, v]) => {
      fd.set(k, typeof v === "boolean" ? (v ? "true" : "false") : String(v));
    });
    submit(fd, { method: "post" });
  };

  const set = <K extends keyof BudgetSettings>(key: K, value: BudgetSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="予算設定"
        backAction={{ content: "ホーム", onAction: () => navigate("/app" + q) }}
      >
        <TabGroupBar tabs={REPORTS_TABS} />
        {/* 保存は Shopify の保存の帯（値が保存したときと違うときだけ「破棄」「保存」）。画面の中に保存ボタンを置かない（UI ルール v1.1 7章） */}
        <StateSaveForm values={form} onSave={handleSave} onDiscard={(saved) => setForm(saved)} result={actionData}>
          <Layout>
            {/* 保存の成功はトーストで出し、保存のたびに出す（UI ルール v1.1 7章） */}
            <SuccessToast message={actionData?.ok ? "保存しました" : null} trigger={actionData} />
            <Layout.Section>
              {/* 画面全体の説明は AdminIntro（1〜2文）。お知らせ枠は1画面に1つまでにする（2章・5章） */}
              <AdminIntro><p>予算の入力単位・適用モード・CSV操作・手動編集・一括編集の有無を設定します。実際の予算データは「レポート・履歴」の予算管理で登録・編集します。</p></AdminIntro>
            </Layout.Section>

            <Layout.AnnotatedSection title="CSV操作">
              <Card>
                <BlockStack gap="300">
                  <Checkbox
                    label="CSV列マッピングを有効にする"
                    checked={form.csvColumnMappingEnabled}
                    onChange={(v) => set("csvColumnMappingEnabled", v)}
                    helpText="CSVの列名を date / location / budget 等にマッピング可能にします"
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection title="手動編集">
              <Card>
                <BlockStack gap="300">
                  <Checkbox
                    label="手動で予算を編集可能"
                    checked={form.manualBudgetEditEnabled}
                    onChange={(v) => set("manualBudgetEditEnabled", v)}
                  />
                  <Checkbox
                    label="一括編集を許可"
                    checked={form.bulkEditEnabled}
                    onChange={(v) => set("bulkEditEnabled", v)}
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection title="表示・適用">
              <Card>
                <BlockStack gap="400">
                  <Select
                    label="予算入力単位"
                    options={INPUT_UNIT_OPTIONS}
                    value={form.budgetInputUnit}
                    onChange={(v) => set("budgetInputUnit", v as BudgetSettings["budgetInputUnit"])}
                  />
                  <Select
                    label="予算適用モード"
                    options={APPLY_MODE_OPTIONS}
                    value={form.budgetApplyMode}
                    onChange={(v) => set("budgetApplyMode", v as BudgetSettings["budgetApplyMode"])}
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>
          </Layout>
        </StateSaveForm>
      </Page>
    </PolarisPageWrapper>
  );
}
