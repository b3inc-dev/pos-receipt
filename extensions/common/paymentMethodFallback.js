/** 注文詳細から、返金元として最優先する成功済み売上取引を選ぶ。 */
export function primarySaleTransaction(order) {
  const candidates = [...(order?.transactions ?? [])].filter((tx) =>
    ["SALE", "CAPTURE"].includes(String(tx?.kind ?? "").toUpperCase()),
  );
  const succeeded = candidates.filter(
    (tx) => String(tx?.status ?? "").toUpperCase() === "SUCCESS",
  );
  // 旧レスポンスでstatus自体が無い場合だけ互換fallbackに含める。
  const selectable = succeeded.length > 0
    ? succeeded
    : candidates.filter((tx) => !String(tx?.status ?? "").trim());
  return selectable
    .sort((a, b) => Number(b?.amount ?? 0) - Number(a?.amount ?? 0))[0] ?? null;
}

/**
 * 支払方法マスタ同期が失敗しても、注文の実gatewayを選択肢から失わない。
 */
export function paymentMethodsWithOrderGateway(methods, order) {
  const saleTx = primarySaleTransaction(order);
  const gateway = String(saleTx?.gateway ?? "").trim();
  if (!gateway) return methods;
  const normalized = gateway.toLowerCase();
  if (methods.some((method) => String(method.value ?? "").toLowerCase() === normalized)) {
    return methods;
  }
  return [
    ...methods,
    {
      value: gateway,
      label: saleTx?.displayName || saleTx?.formattedGateway || gateway,
    },
  ];
}
