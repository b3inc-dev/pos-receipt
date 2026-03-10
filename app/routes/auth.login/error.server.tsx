import type { LoginError } from "@shopify/shopify-app-react-router/server";
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";

interface LoginErrorMessage {
  shop?: string;
}

export function loginErrorMessage(loginErrors: LoginError): LoginErrorMessage {
  if (loginErrors?.shop === LoginErrorType.MissingShop) {
    return { shop: "ショップドメインを入力してください" };
  }
  if (loginErrors?.shop === LoginErrorType.InvalidShop) {
    return { shop: "有効なショップドメインを入力してください" };
  }
  return {};
}
