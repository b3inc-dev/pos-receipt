import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import "@shopify/polaris/build/esm/styles.css";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { shop: new URL(request.url).searchParams.get("shop") ?? "" };
};

export const headers: HeadersFunction = (args) => boundary.headers(args);

export default function AppLayout() {
  const { shop } = useLoaderData<typeof loader>();

  return (
    <AppProvider>
      <Outlet context={{ shop }} />
    </AppProvider>
  );
}
