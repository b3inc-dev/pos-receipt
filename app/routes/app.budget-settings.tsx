/**
 * /app/budget-settings — 予算設定（要件 §11）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSubmit, useLocation, useNavigate } from "react-router";
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
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<BudgetSettings>({ ...initial });

  const handleSave = () => {
    const fd = new FormData();
    Object.entries(form).forEach(([k, v]) => {
      fd.set(k, typeof v === "boolean" ? (v ? "true" : "false") : String(v));
    });
    submit(fd, { method: "post" });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const set = <K extends keyof BudgetSettings>(key: K, value: BudgetSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="予算設定"
        backAction={{ content: "戻る", onAction: () => navigate("/app/settings" + q) }}
        primaryAction={{ content: "保存", onAction: handleSave }}
      >
        <Layout>
          {saved && <Layout.Section><Banner tone="success">保存しました。</Banner></Layout.Section>}
          <Layout.Section>
            <Banner tone="info">予算の入力単位・適用モード・CSV操作・手動編集・一括編集の有無を設定します。実際の予算データは「予算管理」で登録・編集します。</Banner>
          </Layout.Section>

          <Layout.AnnotatedSection title="CSV操作" description="§11.2.1">
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

          <Layout.AnnotatedSection title="手動編集" description="§11.2.2">
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

          <Layout.AnnotatedSection title="表示・適用" description="§11.2.3">
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

          <Layout.Section>
            <InlineStack align="end"><Button variant="primary" onClick={handleSave}>保存</Button></InlineStack>
          </Layout.Section>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
