import { BlockStack, Button, Card, Select, Text } from "@shopify/polaris";
import { MC_PRINT3_HELP_URL, normalizePrinterProfile, PRINTER_PROFILE_OPTIONS, type ReceiptPrinterProfile } from "../services/receiptPrinterProfile";

export function ReceiptPrinterSettings({ value, onChange }: { value: ReceiptPrinterProfile; onChange: (value: ReceiptPrinterProfile) => void }) {
  return (
            <Card>
              <BlockStack gap="300">
                <Select label="58mmのプリンター補正" options={PRINTER_PROFILE_OPTIONS}
                  value={value} onChange={(v) => onChange(normalizePrinterProfile(v))}
                  helpText="精算・点検・領収書・販売・ギフトのブロックとコードに共通で使います。このストアの全店舗・全端末に共通です。異なる機種を併用している場合は、補正が不要な端末にも適用されるため標準を選んでください。" />
                <Text as="p">横に細く印刷され、右端の文字が欠ける場合は「58mmの横縮み・右端欠けを補正」を選んで試してください。正方形が縦長になる症状をMCP31LBで確認し、補正後の縦横比と右端を実機で確認しています。</Text>
                <Text as="p" tone="subdued">ShopifyはmC-Print3系について、POSの印刷幅は80mmのみで、58mm用紙では一部が欠けると案内しています。この補正は本アプリの帳票向けの対処です。Shopify標準レシートの設定は変わりません。他の機種・接続・プリンター設定で同じ結果になるかは、印刷して確かめてください。</Text>
                <Text as="p" tone="subdued">横縮みがないmPOPには欠けの補正を使いません。すでにコードで横1.5倍などの補正を入れている場合は、重複しないようコード側の補正を外してください。保存後は各帳票の右端・ロゴ・文字の形を確認してください。</Text>
                <Button url={MC_PRINT3_HELP_URL} external>Shopify公式の用紙幅の案内</Button>
              </BlockStack>
            </Card>
  );
}
