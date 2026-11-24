/**
 * 保護された顧客データ（名前・メールなど）の許可が無いアプリでは、
 * Shopify は customer { displayName email } を含む問い合わせ全体をエラーにする
 * （例: "This app is not approved to use the displayName field. See .../protected-customer-data"）。
 * そのときは名前を読まない問い合わせで読み直す（2026-11-23 開発ストアの検証用アプリで確認）。
 */

/** GraphQL のエラー一覧が「保護された顧客データの許可が無い」ものか */
export function isProtectedCustomerDataError(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    const msg = String((e as { message?: unknown })?.message ?? e ?? "");
    return /protected-customer-data|not approved to use/i.test(msg);
  });
}

type GraphqlAdmin = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

/**
 * まず query で読み、保護された顧客データで断られたら fallbackQuery で読み直す。
 * admin.graphql はエラーで例外を投げることも、errors を返すこともあるので、どちらでも読み直す。
 */
export async function graphqlWithCustomerFallback(
  admin: GraphqlAdmin,
  query: string,
  fallbackQuery: string,
  variables: Record<string, unknown>,
  /** 記録（ログ）に残す店の名前（ドメイン）。顧客の値は残さない */
  shopDomain?: string,
): Promise<{ data?: any; errors?: unknown[] }> {
  try {
    const response = await admin.graphql(query, { variables });
    const json = (await response.json()) as { data?: any; errors?: unknown[] };
    if (!(json.errors?.length && isProtectedCustomerDataError(json.errors))) return json;
  } catch (e) {
    const errs =
      (e as { body?: { errors?: unknown } })?.body?.errors ?? (e as { errors?: unknown })?.errors;
    const list = Array.isArray(errs) ? errs : (errs as { graphQLErrors?: unknown[] })?.graphQLErrors;
    const msg = e instanceof Error ? e.message : String(e);
    if (!isProtectedCustomerDataError(list) && !isProtectedCustomerDataError([{ message: msg }])) throw e;
  }
  // 公開アプリで許可が外れたときに気づけるよう、店の名前だけ 1 行残す（見直し P3、2026-11-24）
  console.info(`[protected-customer-data] 顧客の名前を読む許可が無いため、名前なしで読み直しました shop=${shopDomain ?? "?"}`);
  const response = await admin.graphql(fallbackQuery, { variables });
  return (await response.json()) as { data?: any; errors?: unknown[] };
}
