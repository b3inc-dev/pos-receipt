import { BlockStack, Card, Checkbox, Select, Text, TextField } from "@shopify/polaris";
import type { ReceiptDesignBasics as Basics } from "../services/receiptDesignSettings";
import type { ReceiptKind } from "../services/receiptLayoutSchema";
import type { ReceiptTemplateData } from "../utils/receiptTemplateData";

export function ReceiptDesignBasics({ kind, value, custom, onChange }: { kind: ReceiptKind; value: Basics; custom: boolean; onChange: (next: Basics) => void }) {
  const sales = value.sales;
  const updateSales = (patch: object) => onChange({ ...value, sales: { ...sales!, ...patch } });
  const receipt = value.receipt;
  const updateReceipt = (key: keyof ReceiptTemplateData, v: unknown) => {
    const next = { ...receipt!, [key]: v };
    next.showOrderNumber = next.showOrderName; next.showDate = next.showIssueDate;
    onChange({ ...value, receipt: next });
  };
  const text = (key: keyof ReceiptTemplateData, label: string) => <TextField key={key} label={label} value={String(receipt?.[key] ?? "")} autoComplete="off" onChange={(v) => updateReceipt(key, key === "logoUrl" ? v || null : v)} />;
  return <Card><BlockStack gap="300">
    <Text as="h2" variant="headingMd">基本設定</Text>
    <Select label="印字する用紙幅" value={String(value.paperWidthMm)} options={[{ label: "58mm", value: "58" }, { label: "80mm", value: "80" }]}
      onChange={(v) => onChange({ ...value, paperWidthMm: v === "58" ? 58 : 80, ...(sales ? { sales: { ...sales, paperWidthMm: v === "58" ? 58 : 80 } } : {}) })}
      helpText={kind === "sales" || kind === "gift" ? "販売・ギフトで共通です。デザインの見本にもこの幅を使います。" : "精算・点検・領収書で共通です。印字設定の用紙幅も同じ値になります。"} />
    {sales ? <Checkbox label="販売・ギフトレシートの印字を有効にする" checked={sales.enabled} onChange={(enabled) => updateSales({ enabled })} /> : null}
    {kind === "receipt" ? <>
      <Text as="h3" variant="headingSm">発行時の初期値</Text>
      {text("defaultProviso", "既定の但し書き")}{text("defaultRecipientSuffix", "宛名の後ろに付ける文字")}
      <Text as="p" tone="subdued">変更は次回発行分から使います。発行済み領収書の内容は変わりません。</Text>
      <Text as="h3" variant="headingSm">発行元情報</Text>
      {([ ["companyName", "会社名・店舗名"], ["postalCode", "郵便番号"], ["address", "住所1"], ["address2", "住所2"], ["phone", "電話番号"] ] as const).map(([k,l]) => text(k,l))}
      {custom ? <Text as="p" tone="subdued">作成したデザインはブロック・コードに指定した表示を使います。発行元情報を固定文字で入れている場合は、デザイン側も編集してください。</Text> : null}
      <details><summary>表示・文言の詳細設定</summary><BlockStack gap="300">
        <Text as="p" tone="subdued">保存済みの設定を引き継いでいます。作成したデザインの表示はブロック・コードで編集します。標準印字は右の見本で反映を確認してください。</Text>
        {([ ["receiptTemplateName", "設定の名前"], ["logoUrl", "ロゴ画像URL"], ["receiptTitle", "領収書タイトル"], ["reissueLabel", "再発行の文言"], ["taxNoteLabel", "税注記"], ["currencyPrefix", "通貨の表記"] ] as const).map(([k,l]) => text(k,l))}
        {([ ["showIssueDate", "発行日"], ["showOrderName", "注文番号"], ["showLocationName", "店舗名"], ["showCustomerName", "宛名"], ["showProviso", "但し書き"], ["showAmount", "金額"], ["showTaxNote", "税注記"], ["showReissueMark", "再発行の印"] ] as const).map(([k,l]) => <Checkbox key={k} label={l} checked={receipt![k]} onChange={(v) => updateReceipt(k,v)} />)}
        {([ ["headerAlignment", "見出しの揃え", ["left", "center", "right"], ["左", "中央", "右"]], ["logoPosition", "ロゴの位置", ["top", "inline"], ["上部", "横並び"]], ["companyInfoPosition", "会社情報の位置", ["top", "bottom"], ["上部", "下部"]], ["amountEmphasisMode", "金額の強調", ["normal", "emphasis"], ["標準", "強調"]], ["bodySpacing", "本文の間隔", ["compact", "normal", "relaxed"], ["詰める", "標準", "ゆったり"]] ] as const).map(([k,l,values,labels]) => <Select key={k} label={l} value={receipt![k]} options={values.map((v,i) => ({value:v,label:labels[i]}))} onChange={(v) => updateReceipt(k,v)} />)}
      </BlockStack></details>
    </> : null}
    {kind === "sales" && !custom ? <>
      <TextField label="見出し" value={sales!.headerTitle} onChange={(headerTitle) => updateSales({ headerTitle })} autoComplete="off" />
      <TextField label="末尾の文言" value={sales!.footerNote} onChange={(footerNote) => updateSales({ footerNote })} autoComplete="off" multiline={2} />
      {([ ["printOrderAttributes", "注文ごとの追加項目"], ["printLineAttributes", "商品ごとの追加項目"] ] as const).map(([key,label]) => <Checkbox key={key} label={label} checked={sales![key]} onChange={(v) => updateSales({ [key]: v })} />)}
      {([ ["showLocation", "店舗名"], ["showPayments", "支払内訳"], ["showSku", "SKU"] ] as const).map(([key,label]) => <Checkbox key={key} label={label} checked={sales!.layoutJson[key]} onChange={(v) => updateSales({ layoutJson: { ...sales!.layoutJson, [key]:v } })} />)}
    </> : null}
    {kind === "gift" && !custom ? <>
      <TextField label="ギフトの見出し" value={value.gift!.title} maxLength={80} onChange={(title) => onChange({ ...value, gift: { ...value.gift!, title } })} autoComplete="off" />
      <TextField label="ギフトの末尾文" value={value.gift!.footer} maxLength={500} onChange={(footer) => onChange({ ...value, gift: { ...value.gift!, footer } })} autoComplete="off" multiline={2} />
      <Checkbox label="ギフトに注文番号を表示" checked={value.gift!.showOrderNumber} onChange={(showOrderNumber) => onChange({ ...value, gift: { ...value.gift!, showOrderNumber } })} />
    </> : null}
    {kind === "settlement" ? <>
      <Checkbox label="点検としてプレビュー" checked={value.isInspection} onChange={(isInspection) => onChange({ ...value, isInspection })} />
      <Checkbox label="見本に商品券釣有り差額を含める" checked={value.showVoucherChange} onChange={(showVoucherChange) => onChange({ ...value, showVoucherChange })} />
      <Text as="p" tone="subdued">見本の切り替えです。実際の精算・点検の金額や計算方法は変わりません。</Text>
    </> : null}
  </BlockStack></Card>;
}
