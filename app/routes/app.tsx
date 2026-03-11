import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import "@shopify/polaris/build/esm/styles.css";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {
    shop: new URL(request.url).searchParams.get("shop") ?? "",
    apiKey: process.env.SHOPIFY_API_KEY ?? "",
  };
};

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function AppLayout() {
  const { shop, apiKey } = useLoaderData<typeof loader>();

  return (
    <PolarisAppProvider i18n={enTranslations}>
      <AppProvider embedded apiKey={apiKey}>
        <Outlet context={{ shop }} />
      </AppProvider>
    </PolarisAppProvider>
  );
}
