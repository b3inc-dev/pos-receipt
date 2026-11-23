/**
 * /app/receipt-layouts/print-data — 印字の値の設定（レイアウトの印字で使う並べ方と計算）
 *
 * 精算エンジンの金額は変えない。決めるのは印字のときの並べ方と、納金額の式に入れる店・支払方法だけ。
 * 保存先: AppSetting（receipt_layout_settlement_calc_v1・receipt_layout_sales_data_v1）。保存は Shopify の保存の帯。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useLocation, useNavigate, useNavigation } from "react-router";
import {
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useCallback, useEffect, useRef, useState } from "react";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getAppSetting, setAppSetting } from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { AdminIntro, DeleteIconButton, SaveBar, StatusBanner, SuccessToast, markFormDirty } from "../components/admin-ui";
import {
  CIARA_SETTLEMENT_CALC,
  DEFAULT_SALES_DATA,
  normalizeSalesData,
  normalizeSettlementCalc,
  SALES_DATA_SETTING_KEY,
  SETTLEMENT_CALC_SETTING_KEY,
  type PaymentGroupRule,
  type SalesDataSettings,
  type SettlementCalcSettings,
} from "../services/receiptLayoutSettlementCalc";

type Values = { calc: SettlementCalcSettings; sales: SalesDataSettings };

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const [calc, sales] = await Promise.all([
    getAppSetting<unknown>(shop.id, SETTLEMENT_CALC_SETTING_KEY),
    getAppSetting<unknown>(shop.id, SALES_DATA_SETTING_KEY),
  ]);
  const values: Values = { calc: normalizeSettlementCalc(calc), sales: normalizeSalesData(sales) };
  return { values };
}

type ActionData = { ok: true; values: Values; savedAt: number } | { ok: false; errors: string[] };

export async function action({ request }: ActionFunctionArgs): Promise<ActionData> {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const form = await request.formData();
  let raw: { calc?: unknown; sales?: unknown };
  try {
    raw = JSON.parse(String(form.get("values") ?? "")) as { calc?: unknown; sales?: unknown };
  } catch {
    return { ok: false, errors: ["設定を読み取れませんでした。画面を開き直してください。"] };
  }
  const errors: string[] = [];
  const groups = Array.isArray((raw.calc as { groups?: unknown })?.groups)
    ? ((raw.calc as { groups: Record<string, unknown>[] }).groups)
    : [];
  groups.forEach((g, i) => {
    const hasMembers = Array.isArray(g?.members) && g.members.some((m) => String(m ?? "").trim());
    if (!String(g?.label ?? "").trim()) errors.push(`まとめの行 ${i + 1}: 印字する名前を入れてください。`);
    if (!hasMembers) errors.push(`まとめの行 ${i + 1}: まとめる支払方法を 1 つ以上入れてください。`);
  });
  if (errors.length) return { ok: false, errors };
  const values: Values = { calc: normalizeSettlementCalc(raw.calc), sales: normalizeSalesData(raw.sales) };
  await Promise.all([
    setAppSetting(shop.id, SETTLEMENT_CALC_SETTING_KEY, values.calc),
    setAppSetting(shop.id, SALES_DATA_SETTING_KEY, values.sales),
  ]);
  return { ok: true, values, savedAt: Date.now() };
}

const lines = (list: string[]) => list.join("\n");
const toList = (text: string) => text.split(/\r?\n/);

function ListField({
  label,
  helpText,
  value,
  onChange,
}: {
  label: string;
  helpText?: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  // 打っている途中の空の行を消さないよう、文字のまま持つ
  const [text, setText] = useState(lines(value));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(lines(value));
    }
  }, [value]);
  return (
    <TextField
      label={label}
      helpText={helpText}
      value={text}
      multiline={3}
      autoComplete="off"
      onChange={(t) => {
        setText(t);
        const next = toList(t);
        last.current = next;
        onChange(next);
      }}
    />
  );
}

export default function ReceiptLayoutPrintData() {
  const { values: loaded } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const q = useLocation().search;

  const [baseline, setBaseline] = useState<Values>(loaded);
  const [values, setValues] = useState<Values>(loaded);
  const hidden = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (actionData?.ok) {
      setBaseline(actionData.values);
      setValues(actionData.values);
    }
  }, [actionData]);
  const [errorsDismissed, setErrorsDismissed] = useState(false);
  useEffect(() => setErrorsDismissed(false), [actionData]);

  const change = useCallback((next: Values) => {
    setValues(next);
    window.setTimeout(() => markFormDirty(hidden.current), 0);
  }, []);
  const setCalc = (patch: Partial<SettlementCalcSettings>) => change({ ...values, calc: { ...values.calc, ...patch } });
  const setGroup = (i: number, patch: Partial<PaymentGroupRule>) =>
    setCalc({ groups: values.calc.groups.map((g, j) => (j === i ? { ...g, ...patch } : g)) });

  const onDiscard = useCallback(() => {
    setErrorsDismissed(true);
    setValues(baseline);
  }, [baseline]);

  const saving = navigation.state === "submitting";
  const errors = actionData && !actionData.ok && !errorsDismissed ? actionData.errors : null;
  const c = values.calc;

  return (
    <PolarisPageWrapper>
      <Page
        title="印字の値の設定"
        backAction={{ content: "レシートのレイアウト", onAction: () => navigate("/app/receipt-layouts" + q) }}
      >
        <Form method="post">
          <input ref={hidden} type="hidden" name="values" value={JSON.stringify(values)} readOnly />
          <SuccessToast message={actionData?.ok ? "保存しました" : null} trigger={actionData} />
          <SaveBar failed={Boolean(errors) && !saving} tone={errors ? "critical" : "success"} onDiscard={onDiscard} />
          <Layout>
            <Layout.Section>
              <AdminIntro>
                レイアウトで印字するときの、支払方法の並び順・まとめの行・納金額の計算と、スタッフ名の探し方を決めます。精算の金額そのもの（総売上・支払方法ごとの取引額など）は変わりません。
              </AdminIntro>
            </Layout.Section>
            {errors ? (
              <Layout.Section>
                <StatusBanner tone="critical" heading="保存できませんでした">
                  <ul style={{ margin: 0, paddingLeft: 20 }}>
                    {errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </StatusBanner>
              </Layout.Section>
            ) : null}

            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center" gap="200">
                    <Text as="h2" variant="headingMd">精算・点検: 支払方法の並び</Text>
                    <Button
                      onClick={() =>
                        change({
                          ...values,
                          calc: {
                            ...CIARA_SETTLEMENT_CALC,
                            // 店は Ciara のロケーションで入れ直すので、今の値があれば残す
                            refundDeductLocations: c.refundDeductLocations.length
                              ? c.refundDeductLocations
                              : CIARA_SETTLEMENT_CALC.refundDeductLocations,
                          },
                          sales: { ...DEFAULT_SALES_DATA },
                        })
                      }
                    >
                      Ciara の値を入れる
                    </Button>
                  </InlineStack>
                  <ListField
                    label="支払方法を印字する順（1 行に 1 つ）"
                    helpText="支払方法の名前と同じに書きます（大文字小文字は区別しません）。ここに無い支払方法は、後ろに元の順で出します。空なら並べ替えません。"
                    value={c.paymentOrder}
                    onChange={(v) => setCalc({ paymentOrder: v })}
                  />
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">精算・点検: まとめの行</Text>
                    <Text as="p" tone="subdued">
                      いくつかの支払方法を足した行を出します（例: 電子マネー(合計)）。動きのある支払方法が決めた数以上のときだけ出します。
                    </Text>
                  </BlockStack>
                  {c.groups.length === 0 ? <Text as="p" tone="subdued">まとめの行はありません。</Text> : null}
                  {c.groups.map((g, i) => (
                    <Box key={i} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                      <BlockStack gap="300">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h3" variant="headingSm">{`まとめの行 ${i + 1}`}</Text>
                          <DeleteIconButton
                            label={`まとめの行 ${i + 1} を削除`}
                            onClick={() => setCalc({ groups: c.groups.filter((_, j) => j !== i) })}
                          />
                        </InlineStack>
                        <TextField
                          label="印字する名前"
                          value={g.label}
                          autoComplete="off"
                          onChange={(v) => setGroup(i, { label: v })}
                        />
                        <ListField
                          label="まとめる支払方法（1 行に 1 つ）"
                          value={g.members}
                          onChange={(v) => setGroup(i, { members: v })}
                        />
                        <TextField
                          label="この支払方法の後に出す"
                          helpText="空なら最後に出します。"
                          value={g.insertAfter}
                          autoComplete="off"
                          onChange={(v) => setGroup(i, { insertAfter: v })}
                        />
                        <TextField
                          label="出す条件（動きのある支払方法の数）"
                          type="number"
                          min={1}
                          max={20}
                          value={String(g.minActive)}
                          autoComplete="off"
                          suffix="つ以上"
                          onChange={(v) => setGroup(i, { minActive: Math.max(1, Math.min(20, Math.round(Number(v) || 1))) })}
                        />
                      </BlockStack>
                    </Box>
                  ))}
                  <InlineStack>
                    <Button
                      disabled={c.groups.length >= 10}
                      onClick={() =>
                        setCalc({ groups: [...c.groups, { label: "", members: [], insertAfter: "", minActive: 2 }] })
                      }
                    >
                      まとめの行を追加
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">精算・点検: 納金額</Text>
                    <Text as="p" tone="subdued">
                      納金額 ＝ 現金の取引額 − 下の店での、下の支払方法の返金 − 商品券釣り。レイアウトの「納金額」のブロックで出ます。
                    </Text>
                  </BlockStack>
                  <ListField
                    label="現金とみなす支払方法（1 行に 1 つ）"
                    helpText="名前にこの文字を含む支払方法の取引額を足します。"
                    value={c.cashLabels}
                    onChange={(v) => setCalc({ cashLabels: v })}
                  />
                  <ListField
                    label="返金を納金額から引く店（1 行に 1 つ）"
                    helpText="店の表示名か、Shopify のロケーション ID（数字）を書きます。空なら引きません。"
                    value={c.refundDeductLocations}
                    onChange={(v) => setCalc({ refundDeductLocations: v })}
                  />
                  <ListField
                    label="上の店で、返金を引く支払方法（1 行に 1 つ）"
                    helpText="名前にこの文字を含む支払方法の返金額を引きます（例: wespo・nanaco・edy）。"
                    value={c.refundDeductMethods}
                    onChange={(v) => setCalc({ refundDeductMethods: v })}
                  />
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">販売レシート: スタッフ名</Text>
                  <ListField
                    label="スタッフ名を探す明細のプロパティ名（1 行に 1 つ）"
                    helpText="明細のプロパティからスタッフ名を集め、同じ名前は 1 回にして「 / 」でつなぎます。見つからなければ POS で選んだ担当スタッフを出します。"
                    value={values.sales.staffPropertyKeys}
                    onChange={(v) => change({ ...values, sales: { staffPropertyKeys: v } })}
                  />
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>
        </Form>
      </Page>
    </PolarisPageWrapper>
  );
}
