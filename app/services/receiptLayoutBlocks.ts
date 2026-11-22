/**
 * レシートのブロック一覧（ブロックエディタの部品）
 *
 * 各ブロックは「設定の欄」と「Liquid の断片」を持つ。
 * 断片は設定を s_<key> という変数で読む（receiptLayoutRender.ts の blocksToCode が値を渡す）。
 * 文言の欄には {{ order.name }} のような差し込みが書ける（{% %} のタグは書けない）。
 * 文言の欄の値はレンダラが HTML エスケープ済みにするので、断片では `| raw` で出す。
 */
import type { BlockSettingValue, ReceiptKind } from "./receiptLayoutSchema";

export type SettingOption = { value: string; label: string };

export type SettingDef =
  | { key: string; label: string; type: "text"; default: string; help?: string; placeholder?: string }
  | { key: string; label: string; type: "textarea"; default: string; help?: string }
  | { key: string; label: string; type: "url"; default: string; help?: string }
  | { key: string; label: string; type: "checkbox"; default: boolean; help?: string }
  | { key: string; label: string; type: "select"; default: string; options: SettingOption[]; help?: string }
  | { key: string; label: string; type: "number"; default: number; min: number; max: number; unit?: string; help?: string };

export type BlockDef = {
  type: string;
  label: string;
  /** ブロックを追加するときの説明（1 文） */
  description: string;
  kinds: readonly ReceiptKind[];
  settings: SettingDef[];
  /** Liquid の断片。設定は s_<key> で読む */
  template: string;
  /** 設定から決まる値（例: 精算の行の金額／件数の書き方）。s_<key> として断片に渡す */
  derived?: (settings: Record<string, BlockSettingValue>) => Record<string, BlockSettingValue>;
  /** 一覧の中で見出しにする設定（例: 見出しの文言） */
  summaryKey?: string;
};

const ALL: readonly ReceiptKind[] = ["settlement", "sales", "gift", "receipt"];

const ALIGN: SettingOption[] = [
  { value: "left", label: "左" },
  { value: "center", label: "中央" },
  { value: "right", label: "右" },
];
const SIZE: SettingOption[] = [
  { value: "s", label: "小" },
  { value: "m", label: "標準" },
  { value: "l", label: "大" },
  { value: "xl", label: "特大" },
];
const LINE: SettingOption[] = [
  { value: "none", label: "なし" },
  { value: "solid", label: "細線" },
  { value: "thick", label: "太線" },
  { value: "dashed", label: "破線" },
  { value: "dotted", label: "点線" },
];

const align = (d = "center"): SettingDef => ({ key: "align", label: "そろえ", type: "select", default: d, options: ALIGN });
const size = (d = "m", key = "size", label = "文字の大きさ"): SettingDef => ({ key, label, type: "select", default: d, options: SIZE });
const line = (key: string, label: string, d: string): SettingDef => ({ key, label, type: "select", default: d, options: LINE });

/** 精算の行に出せる値（Ciara の精算注文メタフィールド settlement.* と同じ名前） */
export const SETTLEMENT_FIELDS: { value: string; label: string; format: "money" | "count" }[] = [
  { value: "total", label: "総売上", format: "money" },
  { value: "net_sales", label: "純売上", format: "money" },
  { value: "tax", label: "消費税", format: "money" },
  { value: "discounts", label: "割引", format: "money" },
  { value: "vip_points_used", label: "ポイント利用額", format: "money" },
  { value: "refund_total", label: "返金", format: "money" },
  { value: "voucher_change", label: "商品券釣有り差額", format: "money" },
  { value: "receipt_cash_manual_delta", label: "領収書現金調整", format: "money" },
  { value: "order_count", label: "件数", format: "count" },
  { value: "refund_count", label: "返金件数", format: "count" },
  { value: "item_count", label: "点数", format: "count" },
];

export const BLOCK_DEFS: BlockDef[] = [
  // ── どのレシートにも使える ──────────────────────────────
  {
    type: "logo",
    label: "ロゴ",
    description: "画像の URL か、店名などの文字を大きく出します。",
    kinds: ALL,
    settings: [
      { key: "image_url", label: "画像の URL", type: "url", default: "", help: "https:// で始まる画像（Shopify の「ファイル」の URL など）。空なら下の文字を出します。" },
      { key: "text", label: "画像がないときの文字", type: "text", default: "{{ shop.name }}" },
      { key: "width_percent", label: "画像の幅", type: "number", default: 50, min: 10, max: 100, unit: "%" },
      { key: "bold", label: "文字を太字", type: "checkbox", default: true },
      align(),
    ],
    template:
      `<div class="blk a-{{ s_align }}">{% if s_image_url != blank %}<img class="logo" src="{{ s_image_url | raw }}" alt="" style="width:{{ s_width_percent }}%"/>{% else %}<div class="logo-text fs-xl{% if s_bold %} b{% endif %}">{{ s_text | raw }}</div>{% endif %}</div>`,
  },
  {
    type: "heading",
    label: "見出し",
    description: "「領収書」「精算レシート」などの表題です。",
    kinds: ALL,
    settings: [
      { key: "text", label: "文言", type: "text", default: "見出し" },
      size("l"),
      { key: "bold", label: "太字", type: "checkbox", default: true },
      align(),
    ],
    template: `<div class="blk a-{{ s_align }} fs-{{ s_size }}{% if s_bold %} b{% endif %}">{{ s_text | raw }}</div>`,
    summaryKey: "text",
  },
  {
    type: "text",
    label: "文章",
    description: "自由な文章です。{{ order.name }} のような差し込みも使えます。",
    kinds: ALL,
    settings: [
      { key: "text", label: "文章", type: "textarea", default: "" },
      size("m"),
      { key: "bold", label: "太字", type: "checkbox", default: false },
      align(),
    ],
    template: `<div class="blk a-{{ s_align }} fs-{{ s_size }}{% if s_bold %} b{% endif %}">{{ s_text | raw }}</div>`,
    summaryKey: "text",
  },
  {
    type: "store_info",
    label: "店舗の情報",
    description: "ロケーションの名前・住所・電話番号です。",
    kinds: ALL,
    settings: [
      { key: "show_name", label: "店舗名を出す", type: "checkbox", default: true },
      { key: "name_bold", label: "店舗名を太字", type: "checkbox", default: true },
      { key: "show_address", label: "住所を出す", type: "checkbox", default: true },
      { key: "show_phone", label: "電話番号を出す", type: "checkbox", default: true },
      size("m"),
      align(),
    ],
    template:
      `<div class="blk a-{{ s_align }} fs-{{ s_size }}">{% if s_show_name and location.name != blank %}<div{% if s_name_bold %} class="b"{% endif %}>{{ location.name }}</div>{% endif %}{% if s_show_address %}{% if location.zip != blank %}<div>{{ location.zip }}</div>{% endif %}{% for line in location.address_lines %}<div>{{ line }}</div>{% endfor %}{% endif %}{% if s_show_phone and location.phone != blank %}<div>{{ location.phone }}</div>{% endif %}</div>`,
  },
  {
    type: "divider",
    label: "区切り線",
    description: "線で区切ります。",
    kinds: ALL,
    settings: [line("style", "線の種類", "dashed")],
    template: `<hr class="hr hr-{{ s_style }}"/>`,
  },
  {
    type: "spacer",
    label: "余白",
    description: "上下に空きを入れます。",
    kinds: ALL,
    settings: [{ key: "height", label: "高さ", type: "number", default: 12, min: 2, max: 120, unit: "px" }],
    template: `<div style="height:{{ s_height }}px"></div>`,
  },

  // ── 販売・ギフト ──────────────────────────────────────
  {
    type: "order_info",
    label: "注文の情報",
    description: "日時・注文番号・スタッフです。",
    kinds: ["sales", "gift"],
    settings: [
      { key: "show_date", label: "日時を出す", type: "checkbox", default: true },
      { key: "date_label", label: "日時の前の文字", type: "text", default: "" },
      { key: "show_order_name", label: "注文番号を出す", type: "checkbox", default: true },
      { key: "order_label", label: "注文番号の前の文字", type: "text", default: "" },
      { key: "show_staff", label: "スタッフを出す", type: "checkbox", default: false },
      { key: "staff_label", label: "スタッフの前の文字", type: "text", default: "スタッフ：" },
      { key: "bold", label: "太字", type: "checkbox", default: false },
      align(),
    ],
    template:
      `<div class="blk a-{{ s_align }}{% if s_bold %} b{% endif %}">{% if s_show_date %}<div>{{ s_date_label | raw }}{{ order.created_at_label }}</div>{% endif %}{% if s_show_staff and staff.name != blank %}<div>{{ s_staff_label | raw }}{{ staff.name }}</div>{% endif %}{% if s_show_order_name %}<div>{{ s_order_label | raw }}{{ order.name }}</div>{% endif %}</div>`,
  },
  {
    type: "line_items",
    label: "商品の明細",
    description: "商品名・バリエーション・SKU・金額です。",
    kinds: ["sales"],
    settings: [
      { key: "show_header", label: "明細の見出しを出す", type: "checkbox", default: true },
      { key: "header_left", label: "見出し（左）", type: "text", default: "アイテム" },
      { key: "header_right", label: "見出し（右）", type: "text", default: "商品価格" },
      line("header_line", "見出しの下の線", "solid"),
      { key: "title_bold", label: "商品名を太字", type: "checkbox", default: true },
      { key: "show_variant", label: "バリエーションを出す", type: "checkbox", default: true },
      { key: "show_sku", label: "SKU を出す", type: "checkbox", default: false },
      {
        key: "quantity",
        label: "数量と単価",
        type: "select",
        default: "always",
        options: [
          { value: "always", label: "いつも出す" },
          { value: "multiple", label: "2 個以上のときだけ" },
          { value: "never", label: "出さない" },
        ],
      },
      { key: "show_properties", label: "商品のプロパティ（属性）を出す", type: "checkbox", default: false },
      { key: "show_discounts", label: "商品ごとの割引を出す", type: "checkbox", default: true },
    ],
    template:
      `<div class="blk">{% if s_show_header %}<div class="row b ul-{{ s_header_line }}"><span>{{ s_header_left | raw }}</span><span>{{ s_header_right | raw }}</span></div>{% endif %}{% for item in order.line_items %}<div class="item"><div class="row"><span{% if s_title_bold %} class="b"{% endif %}>{{ item.title }}</span><span{% if s_title_bold %} class="b"{% endif %}>{{ item.line_total | money }}</span></div>{% if s_show_variant and item.variant_title != blank %}<div>{{ item.variant_title }}</div>{% endif %}{% if s_show_sku and item.sku != blank %}<div>{{ item.sku }}</div>{% endif %}{% if s_quantity == "always" or s_quantity == "multiple" and item.quantity > 1 %}<div>{{ item.quantity }} x {{ item.unit_price | money }}</div>{% endif %}{% if s_show_discounts and item.discount > 0 %}<div class="row"><span>{{ item.discount_label }}</span><span>-{{ item.discount | money }}</span></div>{% endif %}{% if s_show_properties %}{% for p in item.properties %}<div class="indent fs-s">{{ p.key }}: {{ p.value }}</div>{% endfor %}{% endif %}</div>{% endfor %}</div>`,
  },
  {
    type: "totals",
    label: "小計・税・合計",
    description: "小計・割引・消費税・合計です。",
    kinds: ["sales"],
    settings: [
      { key: "show_subtotal", label: "小計を出す", type: "checkbox", default: true },
      { key: "subtotal_label", label: "小計の名前", type: "text", default: "小計" },
      { key: "show_discounts", label: "割引を出す（あるときだけ）", type: "checkbox", default: true },
      { key: "discount_label", label: "割引の名前", type: "text", default: "割引" },
      { key: "show_tax", label: "消費税を出す", type: "checkbox", default: true },
      { key: "tax_label", label: "消費税の名前", type: "text", default: "消費税" },
      { key: "tax_note", label: "消費税の下の文", type: "text", default: "", placeholder: "商品価格に含まれています" },
      { key: "total_label", label: "合計の名前", type: "text", default: "合計" },
      size("m", "total_size", "合計の文字の大きさ"),
      { key: "total_bold", label: "合計を太字", type: "checkbox", default: true },
    ],
    template:
      `<div class="blk">{% if s_show_subtotal %}<div class="row"><span>{{ s_subtotal_label | raw }}</span><span>{{ order.subtotal | money }}</span></div>{% endif %}{% if s_show_discounts and order.discounts > 0 %}<div class="row"><span>{{ s_discount_label | raw }}</span><span>-{{ order.discounts | money }}</span></div>{% endif %}{% if s_show_tax %}{% for t in order.tax_lines %}<div class="row"><span>{{ s_tax_label | raw }} ({{ t.rate_label }}){% if s_tax_note != blank %}<br/>{{ s_tax_note | raw }}{% endif %}</span><span>{{ t.amount | money }}</span></div>{% endfor %}{% endif %}<div class="row fs-{{ s_total_size }}{% if s_total_bold %} b{% endif %}"><span>{{ s_total_label | raw }}</span><span>{{ order.total | money }}</span></div></div>`,
  },
  {
    type: "payments",
    label: "支払方法",
    description: "支払方法ごとの金額とお釣りです。",
    kinds: ["sales"],
    settings: [
      { key: "bold", label: "太字", type: "checkbox", default: false },
      { key: "show_change", label: "お釣りを出す（あるときだけ）", type: "checkbox", default: true },
      { key: "change_label", label: "お釣りの名前", type: "text", default: "お釣り" },
    ],
    template:
      `<div class="blk{% if s_bold %} b{% endif %}">{% for p in order.payments %}<div class="row"><span>{{ p.label }}</span><span>{{ p.amount | money }}</span></div>{% endfor %}{% if s_show_change and order.change > 0 %}<div class="row"><span>{{ s_change_label | raw }}</span><span>{{ order.change | money }}</span></div>{% endif %}</div>`,
  },
  {
    type: "order_attributes",
    label: "注文の属性",
    description: "注文に付いたメモ・属性です（あるときだけ）。",
    kinds: ["sales"],
    settings: [
      { key: "heading", label: "見出し", type: "text", default: "" },
      { key: "show_note", label: "注文メモも出す", type: "checkbox", default: false },
    ],
    template:
      `{% if order.attributes.size > 0 or s_show_note and order.note != blank %}<div class="blk fs-s">{% if s_heading != blank %}<div class="b">{{ s_heading | raw }}</div>{% endif %}{% for a in order.attributes %}<div>{{ a.key }}: {{ a.value }}</div>{% endfor %}{% if s_show_note and order.note != blank %}<div>{{ order.note }}</div>{% endif %}</div>{% endif %}`,
  },
  {
    type: "gift_items",
    label: "ギフトの明細",
    description: "商品名と数量だけを出します（金額は出しません）。",
    kinds: ["gift"],
    settings: [
      { key: "title_bold", label: "商品名を太字", type: "checkbox", default: true },
      { key: "show_variant", label: "バリエーションを出す", type: "checkbox", default: true },
      { key: "show_quantity", label: "数量を出す", type: "checkbox", default: true },
    ],
    template:
      `<div class="blk">{% for item in order.line_items %}<div class="item"><div class="row"><span{% if s_title_bold %} class="b"{% endif %}>{{ item.title }}</span>{% if s_show_quantity %}<span>×{{ item.quantity }}</span>{% endif %}</div>{% if s_show_variant and item.variant_title != blank %}<div>{{ item.variant_title }}</div>{% endif %}</div>{% endfor %}</div>`,
  },

  // ── 精算・点検 ─────────────────────────────────────────
  {
    type: "settlement_meta",
    label: "精算の対象",
    description: "対象の日・ロケーション・集計した時刻です。",
    kinds: ["settlement"],
    settings: [
      { key: "show_period", label: "対象の日を出す", type: "checkbox", default: true },
      { key: "period_label", label: "対象の日の名前", type: "text", default: "日付" },
      { key: "show_location", label: "ロケーションを出す", type: "checkbox", default: true },
      { key: "location_label", label: "ロケーションの名前", type: "text", default: "ロケーション" },
      { key: "show_as_of", label: "集計した時刻を出す", type: "checkbox", default: false },
      { key: "as_of_label", label: "集計した時刻の名前", type: "text", default: "集計" },
    ],
    template:
      `<div class="blk">{% if s_show_period %}<div class="row"><span>{{ s_period_label | raw }}</span><span>{{ settlement.period_label }}</span></div>{% endif %}{% if s_show_location %}<div class="row"><span>{{ s_location_label | raw }}</span><span>{{ settlement.location_label }}</span></div>{% endif %}{% if s_show_as_of and settlement.as_of != blank %}<div class="row"><span>{{ s_as_of_label | raw }}</span><span>{{ settlement.as_of }}</span></div>{% endif %}</div>`,
  },
  {
    type: "settlement_row",
    label: "精算の行",
    description: "総売上・純売上・件数などを 1 行で出します。何行でも足せます。",
    kinds: ["settlement"],
    settings: [
      {
        key: "field",
        label: "出す値",
        type: "select",
        default: "total",
        options: SETTLEMENT_FIELDS.map((f) => ({ value: f.value, label: f.label })),
      },
      { key: "label", label: "名前", type: "text", default: "総売上" },
      { key: "unit", label: "件数のあとの文字", type: "text", default: "件", help: "件数・点数のときだけ使います。" },
      { key: "hide_zero", label: "0 のときは出さない", type: "checkbox", default: false },
      { key: "bold", label: "太字", type: "checkbox", default: false },
    ],
    derived: (s) => ({
      format: SETTLEMENT_FIELDS.find((f) => f.value === s.field)?.format ?? "money",
    }),
    template:
      `{% assign s__v = settlement[s_field] | default: 0 %}{% unless s_hide_zero and s__v == 0 %}<div class="row{% if s_bold %} b{% endif %}"><span>{{ s_label | raw }}</span><span>{% if s_format == "money" %}{{ s__v | money }}{% else %}{{ s__v | number }}{{ s_unit | raw }}{% endif %}</span></div>{% endunless %}`,
    summaryKey: "label",
  },
  {
    type: "settlement_payments",
    label: "支払方法別",
    description: "支払方法ごとの金額・件数・返金です。",
    kinds: ["settlement"],
    settings: [
      { key: "heading", label: "見出し", type: "text", default: "" },
      { key: "show_count", label: "件数を出す", type: "checkbox", default: true },
      { key: "count_unit", label: "件数のあとの文字", type: "text", default: "件" },
      { key: "show_refund", label: "返金を出す（あるときだけ）", type: "checkbox", default: true },
      { key: "refund_label", label: "返金の名前", type: "text", default: "うち返金" },
    ],
    template:
      `<div class="blk">{% if s_heading != blank %}<div class="b">{{ s_heading | raw }}</div>{% endif %}{% for p in settlement.payments %}<div class="row"><span>{{ p.label }}{% if s_show_count %} ({{ p.count | number }}{{ s_count_unit | raw }}){% endif %}</span><span>{{ p.net | money }}</span></div>{% if s_show_refund and p.refund > 0 %}<div class="row indent fs-s"><span>{{ s_refund_label | raw }} {{ p.refund_count | number }}{{ s_count_unit | raw }}</span><span>-{{ p.refund | money }}</span></div>{% endif %}{% endfor %}</div>`,
  },

  // ── 領収書 ──────────────────────────────────────────
  {
    type: "receipt_recipient",
    label: "宛名",
    description: "宛名と「様」です。",
    kinds: ["receipt"],
    settings: [
      { key: "suffix", label: "宛名のあとの文字", type: "text", default: "様" },
      line("underline", "下の線", "solid"),
      size("m"),
    ],
    template:
      `<div class="blk row fs-{{ s_size }} ul-{{ s_underline }}"><span>{{ receipt.recipient }}</span><span>{{ s_suffix | raw }}</span></div>`,
  },
  {
    type: "receipt_amount",
    label: "金額",
    description: "領収した金額です。",
    kinds: ["receipt"],
    settings: [
      { key: "prefix", label: "金額の前の文字", type: "text", default: "" },
      { key: "suffix", label: "金額のあとの文字", type: "text", default: "-" },
      size("xl"),
      line("underline", "下の線", "thick"),
      align(),
    ],
    template:
      `<div class="blk amount a-{{ s_align }} fs-{{ s_size }} b ul-{{ s_underline }}">{{ s_prefix | raw }}{{ receipt.amount | money }}{{ s_suffix | raw }}</div>`,
  },
  {
    type: "receipt_breakdown",
    label: "内訳（税・支払方法）",
    description: "消費税と支払方法の内訳です。",
    kinds: ["receipt"],
    settings: [
      { key: "show_tax", label: "消費税を出す", type: "checkbox", default: true },
      { key: "tax_label", label: "消費税の名前", type: "text", default: "消費税" },
      { key: "show_payments", label: "支払方法を出す", type: "checkbox", default: true },
      { key: "separator", label: "名前と金額の間", type: "text", default: "：" },
      align("right"),
    ],
    template:
      `<div class="blk a-{{ s_align }}">{% if s_show_tax %}{% for t in receipt.tax_lines %}<div>{{ s_tax_label | raw }} ({{ t.rate_label }}){{ s_separator | raw }}{{ t.amount | money }}</div>{% endfor %}{% endif %}{% if s_show_payments %}{% for p in receipt.payments %}<div>{{ p.label }}{{ s_separator | raw }}{{ p.amount | money }}</div>{% endfor %}{% endif %}</div>`,
  },
  {
    type: "receipt_proviso",
    label: "但し書き",
    description: "「但 ◯◯ として」です。",
    kinds: ["receipt"],
    settings: [
      { key: "prefix", label: "前の文字", type: "text", default: "但" },
      { key: "suffix", label: "あとの文字", type: "text", default: "として" },
      line("underline", "下の線", "solid"),
    ],
    template:
      `<div class="blk row ul-{{ s_underline }}"><span>{{ s_prefix | raw }}　{{ receipt.proviso }}</span><span>{{ s_suffix | raw }}</span></div>`,
  },
  {
    type: "receipt_meta",
    label: "発行日・番号",
    description: "発行日・領収書番号・注文番号です。",
    kinds: ["receipt"],
    settings: [
      { key: "show_date", label: "発行日を出す", type: "checkbox", default: true },
      { key: "date_label", label: "発行日の名前", type: "text", default: "発行日" },
      { key: "show_number", label: "領収書番号を出す", type: "checkbox", default: false },
      { key: "number_label", label: "領収書番号の名前", type: "text", default: "No." },
      { key: "show_order", label: "注文番号を出す", type: "checkbox", default: true },
      { key: "order_label", label: "注文番号の名前", type: "text", default: "注文" },
    ],
    template:
      `<div class="blk">{% if s_show_date %}<div class="row"><span>{{ s_date_label | raw }}</span><span>{{ receipt.issue_date }}</span></div>{% endif %}{% if s_show_number and receipt.number != blank %}<div class="row"><span>{{ s_number_label | raw }}</span><span>{{ receipt.number }}</span></div>{% endif %}{% if s_show_order and receipt.order_name != blank %}<div class="row"><span>{{ s_order_label | raw }}</span><span>{{ receipt.order_name }}</span></div>{% endif %}</div>`,
  },
  {
    type: "stamp_box",
    label: "印の枠",
    description: "「担当印」などの四角い枠です。",
    kinds: ["receipt", "settlement"],
    settings: [
      { key: "label", label: "枠の中の文字", type: "text", default: "担当印" },
      { key: "size", label: "枠の大きさ", type: "number", default: 80, min: 40, max: 200, unit: "px" },
      align("right"),
    ],
    template:
      `<div class="blk a-{{ s_align }}"><div class="stamp" style="width:{{ s_size }}px;height:{{ s_size }}px">{{ s_label | raw }}</div></div>`,
  },
  {
    type: "issuer",
    label: "発行者",
    description: "会社名・住所・電話番号・登録番号です。",
    kinds: ["receipt", "sales"],
    settings: [
      { key: "name", label: "会社名", type: "text", default: "{{ shop.name }}" },
      { key: "zip", label: "郵便番号", type: "text", default: "" },
      { key: "address", label: "住所", type: "textarea", default: "" },
      { key: "phone", label: "電話番号", type: "text", default: "" },
      { key: "registration", label: "登録番号の行", type: "text", default: "", placeholder: "登録番号：T1234567890123" },
      { key: "bold", label: "太字", type: "checkbox", default: false },
      align(),
    ],
    template:
      `<div class="blk a-{{ s_align }}{% if s_bold %} b{% endif %}">{% if s_name != blank %}<div>{{ s_name | raw }}</div>{% endif %}{% if s_zip != blank %}<div>{{ s_zip | raw }}</div>{% endif %}{% if s_address != blank %}<div>{{ s_address | raw }}</div>{% endif %}{% if s_phone != blank %}<div>{{ s_phone | raw }}</div>{% endif %}{% if s_registration != blank %}<div>{{ s_registration | raw }}</div>{% endif %}</div>`,
  },
];

const BY_TYPE = new Map(BLOCK_DEFS.map((d) => [d.type, d]));

export function getBlockDef(type: string): BlockDef | undefined {
  return BY_TYPE.get(type);
}

export function blockDefsForKind(kind: ReceiptKind): BlockDef[] {
  return BLOCK_DEFS.filter((d) => d.kinds.includes(kind));
}

export function defaultSettings(def: BlockDef): Record<string, BlockSettingValue> {
  const out: Record<string, BlockSettingValue> = {};
  for (const s of def.settings) out[s.key] = s.default;
  return out;
}
