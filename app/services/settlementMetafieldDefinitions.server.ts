/**
 * Order メタフィールド定義を Shopify に作成する。
 * - namespace `settlement`: 精算結果の書き込み（精算注文）用
 * - namespace `pos`: 特殊返金・商品券調整・返金集計ロケーション等の業務入力用（集計時参照）
 * metafieldDefinitionCreate — 既に存在するキーは userErrors をスキップ扱いにして冪等にする。
 */
type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

const METAFIELD_DEFINITION_CREATE = `#graphql
  mutation SettlementMetafieldDefCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        name
        namespace
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export type SettlementMetafieldDefSpec = {
  /** 管理画面に表示される定義名 */
  name: string;
  namespace: string;
  key: string;
  description: string;
  type: string;
};

/** settlementOrderGas.server の metafieldsSet とキー・型を一致させる */
export const SETTLEMENT_ORDER_METAFIELD_SPECS: SettlementMetafieldDefSpec[] = [
  {
    name: "精算 対象期間",
    namespace: "settlement",
    key: "period_label",
    description: "POS Receipt / 精算レシートの対象期間ラベル（GAS period_label 相当）",
    type: "single_line_text_field",
  },
  {
    name: "精算 ロケーション",
    namespace: "settlement",
    key: "location_label",
    description: "精算対象ロケーション名",
    type: "single_line_text_field",
  },
  {
    name: "精算 更新日時",
    namespace: "settlement",
    key: "as_of",
    description: "集計を書き込んだ日時（現地形式）",
    type: "single_line_text_field",
  },
  {
    name: "精算 バージョン",
    namespace: "settlement",
    key: "version",
    description: "同一注文への上書き回数",
    type: "number_integer",
  },
  {
    name: "精算 総売上",
    namespace: "settlement",
    key: "total",
    description: "税込総売上（円）",
    type: "number_decimal",
  },
  {
    name: "精算 返金合計",
    namespace: "settlement",
    key: "refund_total",
    description: "返金合計（円）",
    type: "number_decimal",
  },
  {
    name: "精算 割引",
    namespace: "settlement",
    key: "discounts",
    description: "割引合計（円）",
    type: "number_decimal",
  },
  {
    name: "精算 VIPポイント利用",
    namespace: "settlement",
    key: "vip_points_used",
    description: "VIPポイント等の利用額（円）",
    type: "number_decimal",
  },
  {
    name: "精算 消費税",
    namespace: "settlement",
    key: "tax",
    description: "内税相当（円）",
    type: "number_decimal",
  },
  {
    name: "精算 純売上",
    namespace: "settlement",
    key: "net_sales",
    description: "税抜純売上（円）",
    type: "number_decimal",
  },
  {
    name: "精算 税（Shopify）",
    namespace: "settlement",
    key: "tax_shopify",
    description: "参考用（GAS 互換、未使用時は 0）",
    type: "number_decimal",
  },
  {
    name: "精算 商品券釣有り",
    namespace: "settlement",
    key: "voucher_change",
    description: "商品券釣有り差額（円）",
    type: "number_integer",
  },
  {
    name: "精算 注文数",
    namespace: "settlement",
    key: "order_count",
    description: "売上注文件数",
    type: "number_integer",
  },
  {
    name: "精算 返金件数",
    namespace: "settlement",
    key: "refund_count",
    description: "返金件数",
    type: "number_integer",
  },
  {
    name: "精算 点数",
    namespace: "settlement",
    key: "item_count",
    description: "販売点数",
    type: "number_integer",
  },
  {
    name: "精算 支払内訳",
    namespace: "settlement",
    key: "payment_sections",
    description: "支払方法別内訳（1行1要素のリスト、GAS と同一形式）",
    type: "list.single_line_text_field",
  },
];

/** namespace はすべて `pos`。値の書き込み・集計ロジックは別実装で pos.* と整合させる */
export const POS_ORDER_BUSINESS_METAFIELD_SPECS: SettlementMetafieldDefSpec[] = [
  {
    name: "POS 特殊返金イベント",
    namespace: "pos",
    key: "special_refund_events",
    description:
      "支払い方法の違う返金などのイベント履歴（JSON 配列）。インストール時に定義のみ作成し、値はアプリが書き込む。",
    type: "json",
  },
  {
    name: "POS 商品券釣り調整",
    namespace: "pos",
    key: "voucher_change_events",
    description:
      "商品券の額面・充当・釣り銭などの調整履歴（JSON 配列）。インストール時に定義のみ作成し、値はアプリが書き込む。",
    type: "json",
  },
  {
    name: "POS 返金集計ロケーション",
    namespace: "pos",
    key: "refund_aggregation_location_gid",
    description:
      "返金・上記調整を計上するロケーションの GID（gid://shopify/Location/...）。未設定時はアプリ側デフォルト",
    type: "single_line_text_field",
  },
  {
    name: "POS 業務調整バージョン",
    namespace: "pos",
    key: "business_adjustments_version",
    description:
      "pos.special_refund_events / pos.voucher_change_events 更新時の楽観ロック用版番号（0 起点でインクリメント）",
    type: "number_integer",
  },
];

function isAlreadyExistsError(message: string, code?: string | null): boolean {
  const m = message.toLowerCase();
  const c = (code ?? "").toUpperCase();
  if (c === "TAKEN" || c === "HANDLE_TAKEN" || c === "DEFINITION_ALREADY_EXISTS") return true;
  if (
    m.includes("already been taken") ||
    m.includes("already exists") ||
    m.includes("duplicate") ||
    m.includes("既に") ||
    m.includes("すでに")
  ) {
    return true;
  }
  return false;
}

export type EnsureSettlementMetafieldsResult = {
  ok: boolean;
  created: string[];
  skipped: string[];
  errors: { key: string; message: string; code?: string }[];
};

async function ensureOrderMetafieldDefinitionsForSpecs(
  admin: AdminClient,
  specs: SettlementMetafieldDefSpec[],
): Promise<EnsureSettlementMetafieldsResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const errors: { key: string; message: string; code?: string }[] = [];

  for (const spec of specs) {
    const res = await admin.graphql(METAFIELD_DEFINITION_CREATE, {
      variables: {
        definition: {
          name: spec.name,
          namespace: spec.namespace,
          key: spec.key,
          description: spec.description,
          type: spec.type,
          ownerType: "ORDER",
        },
      },
    });

    const json = (await res.json()) as {
      errors?: { message: string }[];
      data?: {
        metafieldDefinitionCreate?: {
          createdDefinition?: { id: string } | null;
          userErrors: { field?: string[] | null; message: string; code?: string }[];
        };
      };
    };

    const compoundKey = `${spec.namespace}.${spec.key}`;

    if (json.errors?.length) {
      errors.push({
        key: compoundKey,
        message: json.errors.map((e) => e.message).join(", "),
      });
      continue;
    }

    const payload = json.data?.metafieldDefinitionCreate;
    const uerr = payload?.userErrors ?? [];
    if (payload?.createdDefinition?.id) {
      created.push(compoundKey);
      continue;
    }

    if (uerr.length === 0) {
      errors.push({ key: compoundKey, message: "定義の作成結果が空です" });
      continue;
    }

    const first = uerr[0];
    if (isAlreadyExistsError(first.message, first.code)) {
      skipped.push(compoundKey);
      continue;
    }

    errors.push({
      key: compoundKey,
      message: uerr.map((e) => e.message).join("; "),
      code: first.code,
    });
  }

  return {
    ok: errors.length === 0,
    created,
    skipped,
    errors,
  };
}

/**
 * 注文リソース上の settlement.* メタフィールド定義をすべて作成試行する。
 * 既存定義は skipped に入れ、致命的でない重複のみ冪等に扱う。
 */
export async function ensureSettlementOrderMetafieldDefinitions(
  admin: AdminClient,
): Promise<EnsureSettlementMetafieldsResult> {
  return ensureOrderMetafieldDefinitionsForSpecs(admin, SETTLEMENT_ORDER_METAFIELD_SPECS);
}

/**
 * 注文リソース上の pos.* 業務用メタフィールド定義をすべて作成試行する。
 */
export async function ensurePosOrderBusinessMetafieldDefinitions(
  admin: AdminClient,
): Promise<EnsureSettlementMetafieldsResult> {
  return ensureOrderMetafieldDefinitionsForSpecs(admin, POS_ORDER_BUSINESS_METAFIELD_SPECS);
}

/**
 * インストール／OAuth 完了時: settlement.* と pos.* の Order 定義をまとめて作成する。
 */
export async function ensureAllOrderMetafieldDefinitions(
  admin: AdminClient,
): Promise<EnsureSettlementMetafieldsResult> {
  const settlement = await ensureOrderMetafieldDefinitionsForSpecs(admin, SETTLEMENT_ORDER_METAFIELD_SPECS);
  const pos = await ensureOrderMetafieldDefinitionsForSpecs(admin, POS_ORDER_BUSINESS_METAFIELD_SPECS);
  return {
    ok: settlement.ok && pos.ok,
    created: [...settlement.created, ...pos.created],
    skipped: [...settlement.skipped, ...pos.skipped],
    errors: [...settlement.errors, ...pos.errors],
  };
}
