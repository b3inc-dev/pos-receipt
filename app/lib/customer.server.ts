/**
 * Shopify 顧客から LINE ユーザー ID の顧客メタフィールドで照合し、membership.id（会員番号）を取得する。
 * 読む項目と順番は memberCardLineFields.ts（既定: line_crm.line_user_id → socialplus.line。
 * 環境変数 MEMBER_CARD_LINE_ID_METAFIELDS で並べ替えられる）。照合・取得はサーバーのみで行う。
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { memberMetafieldValues, type MemberMetafieldNode } from "../utils/memberMetafields";
import { lineFieldFilterState, markFieldNotFilterable } from "./memberCardFieldFilter.server";
import {
  customerLineId,
  fieldLabel,
  fieldLineId,
  fullScanQuery,
  isLegacyLineIdField,
  lineFieldSelections,
  readLineIdFields,
  type LineIdField,
} from "../utils/memberCardLineFields";

/** 読む LINE ユーザー ID の項目を別名（lineField0…）で入れた問い合わせ。 */
export function customersQuery(fields: readonly LineIdField[]): string {
  const line = lineFieldSelections(fields);
  return `#graphql
  query findCustomerByLineId($query: String!, $first: Int!, $after: String, ${line.variableDefs}) {
    customers(first: $first, query: $query, after: $after) {
      nodes {
        id
        metafield(namespace: "membership", key: "id") {
          value
        }
        ${line.selections}
        spRankName: metafield(namespace: "shop_point", key: "rank_name") {
          value
        }
        spPointsApproved: metafield(namespace: "shop_point", key: "points_approved") {
          value
        }
        spRankDecisionPurchasePrice: metafield(namespace: "shop_point", key: "rank_decision_purchase_price") {
          value
        }
        spUpcomingExpirations: metafield(namespace: "shop_point", key: "upcoming_expirations") {
          value
        }
        vipRankName: metafield(namespace: "vip", key: "rank_name") {
          value
        }
        vipPointsApproved: metafield(namespace: "vip", key: "points_approved") {
          value
        }
        vipRankDecisionPurchasePrice: metafield(namespace: "vip", key: "rank_decision_purchase_price") {
          value
        }
        vipExpiryDate: metafield(namespace: "vip", key: "expiry_date") {
          value
        }
        vipExpiringPoints: metafield(namespace: "vip", key: "expiring_points") {
          value
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
}

const TAGS_ADD_MUTATION = `#graphql
  mutation tagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

/** タグ検索のプレフィックス。例: "line:u1234..." */
const LINE_TAG_PREFIX = 'line:';

export interface GetMemberIdResult {
  ok: true;
  memberId: string;
  rankName?: string;
  pointsApproved?: string;
  /** ランク判定用累計購入額（円）。未設定時は undefined */
  rankDecisionPurchasePrice?: number;
  /** ポイント失効予定日（shop_point.upcoming_expirations の最も早い日、無ければ vip.expiry_date）。未設定時は undefined */
  expiryDate?: string;
  /** 失効予定ポイント数（同じ日の点数、無ければ vip.expiring_points）。未設定時は undefined */
  expiringPoints?: string;
}

export interface GetMemberIdError {
  ok: false;
  error: "CUSTOMER_NOT_FOUND" | "MEMBER_ID_NOT_SET" | "API_ERROR" | "THROTTLED";
}

export type GetMemberIdResponse = GetMemberIdResult | GetMemberIdError;

const FIRST_PAGE = 250;

/** リトライ上限（Throttled 時） */
const MAX_THROTTLE_RETRIES = 5;
/** 初回待機 ms、以降は指数バックオフ（2s → 4s → 8s → 16s → 32s） */
const THROTTLE_BACKOFF_MS = 2000;

/**
 * Shopify GraphQL の Throttled かどうかを判定する。
 * クライアントは GraphqlQueryError で message に "Throttled" を含めて投げる。
 */
function isThrottledError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = (err as Error & { message?: string }).message ?? "";
    return msg.includes("Throttled");
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** リトライし尽くしたときに投げる印 */
export class ThrottledExhaustedError extends Error {
  constructor() {
    super("Throttled: max retries exhausted");
    this.name = "ThrottledExhaustedError";
  }
}

type CustomersJson = {
  data?: {
    customers?: {
      nodes?: Array<{
        id: string;
        metafield?: { value?: string } | null;
      } & MemberMetafieldNode & Record<string, unknown>>;
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  };
  errors?: Array<{ message?: string }>;
};

type CustomerNode = {
  id: string;
  metafield?: { value?: string } | null;
} & MemberMetafieldNode;

/** ノードからメンバー情報を組み立てる共通処理 */
function buildMemberResult(node: CustomerNode): GetMemberIdResult | GetMemberIdError {
  const memberIdRaw = node?.metafield?.value;
  const memberId = typeof memberIdRaw === "string" ? memberIdRaw.trim() : undefined;
  if (!memberId) return { ok: false, error: "MEMBER_ID_NOT_SET" };

  const { rankName, pointsApproved, rankDecisionPurchasePrice, expiryDate, expiringPoints } = memberMetafieldValues(node);
  return { ok: true, memberId, rankName, pointsApproved, rankDecisionPurchasePrice, expiryDate, expiringPoints };
}

/**
 * LINE user ID（sub）に一致する LINE ユーザー ID の顧客メタフィールドを持つ顧客を検索し、
 * その顧客の membership.id（会員番号）を返す。
 *
 * 顧客の LINE ユーザー ID は、読む項目（既定: line_crm.line_user_id → socialplus.line）を並べた順で
 * 最初に値が入っている項目の値（memberCardLineFields.ts の customerLineId）。
 *
 * ファストパス: tag:"line:<lineUserId>" で1回検索（タグ登録済みの場合）。
 * スローパス:  項目ごとに metafields.<namespace>.<key>:* で全件スキャン（並べた順。ページ制限なし）。
 *              socialplus.line 以外は、定義の絞り込みが効く項目だけ（memberCardFieldFilter.server.ts）。
 *              見つかった顧客に line: タグを fire-and-forget で追加し、次回からファストパスが効く。
 */
export async function getMemberIdByLineId(
  admin: Pick<AdminApiContext, "graphql">,
  lineUserId: string,
  options: { fields?: readonly LineIdField[]; sleep?: (ms: number) => Promise<void>; shop?: string } = {}
): Promise<GetMemberIdResponse> {
  if (!lineUserId?.trim()) {
    return { ok: false, error: "CUSTOMER_NOT_FOUND" };
  }

  const fields = options.fields && options.fields.length > 0 ? options.fields : readLineIdFields();
  const wait = options.sleep ?? sleep;
  const query = customersQuery(fields);
  const lineVariables = lineFieldSelections(fields).variables;
  const lineIdNorm = lineUserId.trim().toLowerCase();
  console.info("[member-card] Searching for LINE sub (last4):", lineIdNorm.slice(-4));

  const matches = (node: CustomerNode & Record<string, unknown>) => {
    const storedLineId = customerLineId(node, fields);
    return Boolean(storedLineId && storedLineId.toLowerCase() === lineIdNorm);
  };

  const runQuery = async (search: string, after: string | null): Promise<CustomersJson> => {
    const res = await admin.graphql(query, {
      variables: { query: search, first: FIRST_PAGE, after, ...lineVariables },
    });
    return (await res.json()) as CustomersJson;
  };

  const runQueryWithRetry = async (
    search: string,
    after: string | null
  ): Promise<CustomersJson> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
      try {
        return await runQuery(search, after);
      } catch (err) {
        lastErr = err;
        if (!isThrottledError(err)) throw err;
        if (attempt === MAX_THROTTLE_RETRIES) {
          console.warn("[member-card] Throttled after", MAX_THROTTLE_RETRIES, "retries, giving up");
          throw new ThrottledExhaustedError();
        }
        const baseMs = THROTTLE_BACKOFF_MS * Math.pow(2, attempt - 1);
        const jitterMs = Math.floor(baseMs * 0.3 * Math.random());
        const waitMs = baseMs + jitterMs;
        console.info("[member-card] Throttled, retry", attempt, "/", MAX_THROTTLE_RETRIES, "after", waitMs, "ms");
        await wait(waitMs);
      }
    }
    throw lastErr;
  };

  try {
    // ── ファストパス: タグ検索（write_customers スコープ取得後、2回目以降に有効）──
    const lineTag = `${LINE_TAG_PREFIX}${lineIdNorm}`;
    const tagJson = await runQuery(`tag:"${lineTag}"`, null).catch(() => null);
    if (tagJson && !tagJson.errors?.length) {
      const tagNodes = tagJson.data?.customers?.nodes ?? [];
      for (const node of tagNodes) {
        if (!node || !matches(node)) continue;
        console.info("[member-card] Cache hit via tag (last4):", lineIdNorm.slice(-4));
        return buildMemberResult(node);
      }
    }

    // ── スローパス: 項目ごとに全件スキャン（件数制限なし）──
    // socialplus.line（前からの項目）は main と同じく、定義を確かめずに全件を見る。
    // ほかの項目は、定義で絞り込みが効く（adminFilterable が FILTERABLE）と確かめられたときだけ見る。
    // 効かない項目で全件を見ない（2026-07 までは条件が無視されて全顧客が返り、2026-10 からはエラーになるため）。
    // 値の空の人が返ってきたら絞り込みが効いていないと見て、その項目は打ち切る。
    // その項目を見られなかったとき（定義を読めない・検索のエラー）は次の項目へ進む。
    // 本物の client（@shopify/shopify-api）は GraphQL の errors・5xx・通信の切断を「投げる」ので、投げられても次へ進む。
    // Throttled を使い切ったときだけは、ほかの項目も同じになるので進まずに THROTTLED を返す。
    console.info("[member-card] Tag miss. Falling back to full scan (last4):", lineIdNorm.slice(-4));
    let gatedFieldFailed = false;

    /** 1 項目を全件スキャンする。見つけた人・"none"（いない）・"failed"（見られなかった）を返す。 */
    const scanField = async (
      field: LineIdField,
      fieldIndex: number
    ): Promise<CustomerNode | "none" | "failed"> => {
      const legacy = isLegacyLineIdField(field);
      if (!legacy) {
        const state = await lineFieldFilterState(admin, options.shop, field);
        if (state !== "usable") {
          console.warn("[member-card] Skip full scan: filter not usable for", fieldLabel(field), state);
          return state === "unknown" ? "failed" : "none";
        }
      }
      const search = fullScanQuery(field);
      let cursor: string | null = null;
      let pageCount = 0;

      while (true) {
        const json = await runQueryWithRetry(search, cursor);

        if (json.errors?.length) {
          // 本文で errors を返す client のとき（@shopify/shopify-api は投げるので下の catch に来る）。
          console.error("Customer query errors:", search, json.errors);
          return "failed";
        }

        const nodes = json.data?.customers?.nodes ?? [];
        const pageInfo = json.data?.customers?.pageInfo;

        if (pageCount === 0) {
          if (nodes.length === 0) {
            console.warn("[member-card]", search, "returned 0 customers.");
            return "none";
          }
          console.info("[member-card] Full scan first page:", search, nodes.length, "customers");
        }

        for (const node of nodes) {
          if (!node) continue;
          if (!legacy && !fieldLineId(node, fieldIndex)) {
            // 絞り込みが効いていれば値のある人だけが返る。値の空の人がいれば全顧客を見ている。
            console.warn("[member-card] Filter ignored (customer without value returned). Stop full scan:", search);
            markFieldNotFilterable(options.shop, field);
            return "none";
          }
          if (matches(node)) return node;
        }

        if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) return "none";

        cursor = pageInfo.endCursor;
        pageCount++;
      }
    };

    for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
      const field = fields[fieldIndex];
      let found: CustomerNode | "none" | "failed";
      try {
        found = await scanField(field, fieldIndex);
      } catch (err) {
        if (err instanceof ThrottledExhaustedError) throw err;
        console.error("[member-card] Full scan failed for", fieldLabel(field), err instanceof Error ? err.message : err);
        found = "failed";
      }
      if (found === "failed") {
        gatedFieldFailed = true;
        continue;
      }
      if (found === "none") continue;

      const node = found;
      // タグを追加して次回からファストパスが効くようにする（fire-and-forget）
      admin.graphql(TAGS_ADD_MUTATION, { variables: { id: node.id, tags: [lineTag] } })
        .then(async (res) => {
          const j = await res.json() as { data?: { tagsAdd?: { userErrors?: Array<{ message?: string }> } } };
          const errs = j.data?.tagsAdd?.userErrors;
          if (errs?.length) console.warn("[member-card] tagsAdd userErrors:", errs);
          else console.info("[member-card] Tag added for future fast lookup (last4):", lineIdNorm.slice(-4));
        })
        .catch((e) => console.warn("[member-card] tagsAdd failed:", e));

      return buildMemberResult(node);
    }
    if (gatedFieldFailed) {
      // 見られなかった項目にいる人かもしれないので「見つからない」とは言わない。
      console.warn("[member-card] No match, but some field could not be scanned. sub (last4):", lineIdNorm.slice(-4));
      return { ok: false, error: "API_ERROR" };
    }
    console.warn("[member-card] No match found. sub (last4):", lineIdNorm.slice(-4));
    return { ok: false, error: "CUSTOMER_NOT_FOUND" };
  } catch (err) {
    if (err instanceof ThrottledExhaustedError) {
      return { ok: false, error: "THROTTLED" };
    }
    console.error("getMemberIdByLineId error:", err);
    return { ok: false, error: "API_ERROR" };
  }
}
