/**
 * /app/receipt-layouts — 4 種のレシートのレイアウト（一覧）
 * 1 行 = 1 種類。押すとブロックエディタ（/app/receipt-layouts/:kind）へ。
 * 「このレイアウトで印字する」を入れた種類だけ、印字がこのレイアウトになる（入れていなければ今までの印字）。
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useLocation, useNavigate } from "react-router";
import { Page, Layout, Card, ResourceList, ResourceItem, Text, Badge, InlineStack, BlockStack, Button } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getAppSetting } from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { AdminIntro } from "../components/admin-ui";
import {
  RECEIPT_KINDS,
  RECEIPT_KIND_LABELS,
  receiptLayoutSettingKey,
  type ReceiptKind,
} from "../services/receiptLayoutSchema";
import { normalizeLayout } from "../services/receiptLayoutValidate";
import { getLayoutPrintEnabled } from "../services/receiptLayoutPrint.server";
import { TabGroupBar, RECEIPT_TABS } from "../components/TabGroupBar";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const enabled = await getLayoutPrintEnabled(shop.id);
  const rows = await Promise.all(
    RECEIPT_KINDS.map(async (kind) => {
      const raw = await getAppSetting<unknown>(shop.id, receiptLayoutSettingKey(kind));
      const layout = normalizeLayout(raw, kind);
      return {
        kind,
        saved: raw !== null,
        printing: enabled[kind] && raw !== null,
        mode: layout.mode,
        blockCount: layout.blocks.filter((b) => !b.hidden).length,
        paperWidthMm: layout.paperWidthMm,
      };
    }),
  );
  return { rows };
}

const DESCRIPTIONS: Record<ReceiptKind, string> = {
  settlement: "精算と点検で同じレイアウトを使います。表題は精算・点検で変わります。",
  sales: "POS で注文を選んで印字する販売レシートです。",
  gift: "金額を出さないギフト用のレシートです。",
  receipt: "宛名・但し書きを入れて発行する領収書です。",
};

export default function ReceiptLayoutsIndex() {
  const { rows } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const q = useLocation().search;
  return (
    <PolarisPageWrapper>
      <Page title="レシートのレイアウト" backAction={{ content: "ホーム", onAction: () => navigate("/app" + q) }}>
        <Layout>
          <Layout.Section>
            <TabGroupBar tabs={RECEIPT_TABS} />
          </Layout.Section>
          <Layout.Section>
            <AdminIntro>ブロックを並べ替えて、印字と同じプレビューを見ながらレシートの見た目を作ります。細かく作り込むときはコードでも編集できます。「このレイアウトで印字する」を入れた種類だけ、印字がこのレイアウトになります。</AdminIntro>
          </Layout.Section>
          <Layout.Section>
            <Card padding="0">
              <ResourceList
                items={rows}
                renderItem={(row) => (
                  <ResourceItem
                    id={row.kind}
                    onClick={() => navigate(`/app/receipt-layouts/${row.kind}${q}`)}
                    accessibilityLabel={`${RECEIPT_KIND_LABELS[row.kind]}を編集`}
                  >
                    <InlineStack align="space-between" blockAlign="center" wrap={false} gap="400">
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingSm">{RECEIPT_KIND_LABELS[row.kind]}</Text>
                        <Text as="p" tone="subdued">{DESCRIPTIONS[row.kind]}</Text>
                      </BlockStack>
                      <InlineStack gap="200" wrap={false} blockAlign="center">
                        {row.printing ? <Badge tone="success">印字に使用中</Badge> : <Badge>今までの印字</Badge>}
                        {row.saved ? null : <Badge>標準</Badge>}
                        <Badge tone={row.mode === "code" ? "attention" : "info"}>
                          {row.mode === "code" ? "コード" : `ブロック ${row.blockCount}`}
                        </Badge>
                        <Text as="span" tone="subdued">{row.paperWidthMm}mm</Text>
                        <span aria-hidden="true">›</span>
                      </InlineStack>
                    </InlineStack>
                  </ResourceItem>
                )}
              />
            </Card>
          </Layout.Section>
          <Layout.Section>
            <Card>
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <BlockStack gap="100">
                  <Text as="h3" variant="headingSm">印字の値の設定</Text>
                  <Text as="p" tone="subdued">精算の支払方法の並び順・まとめの行・納金額と、販売レシートのスタッフ名の探し方です。</Text>
                </BlockStack>
                <Button onClick={() => navigate(`/app/receipt-layouts/print-data${q}`)}>開く</Button>
              </InlineStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
