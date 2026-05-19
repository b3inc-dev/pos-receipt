/**
 * 注文メタフィールド pos.* の書き込み
 */
type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

const METAFIELDS_SET = `#graphql
  mutation PosOrderMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
      }
    }
  }
`;

/** 返金・調整の精算計上ロケーション GID を注文に保存 */
export async function setOrderRefundAggregationLocationGid(
  admin: AdminClient,
  orderId: string,
  locationGid: string | null,
): Promise<void> {
  const ownerId = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
  const value = locationGid?.trim() ? String(locationGid).trim() : "";

  const res = await admin.graphql(METAFIELDS_SET, {
    variables: {
      metafields: [
        {
          ownerId,
          namespace: "pos",
          key: "refund_aggregation_location_gid",
          type: "single_line_text_field",
          value,
        },
      ],
    },
  });

  const json = (await res.json()) as {
    errors?: { message: string }[];
    data?: { metafieldsSet?: { userErrors: { message: string }[] } };
  };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join(", "));
  }
  const uerr = json.data?.metafieldsSet?.userErrors ?? [];
  if (uerr.length > 0) {
    throw new Error(uerr.map((e) => e.message).join("; "));
  }
}
