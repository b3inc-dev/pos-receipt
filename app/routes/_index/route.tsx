import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form } from "react-router";
import { login } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { showForm: Boolean(login) };
};

export default function Index() {
  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif", maxWidth: "400px", margin: "0 auto" }}>
      <h1>POS Receipt</h1>
      <p>商業施設向け精算・領収書・売上サマリー</p>
      <Form method="post" action="/auth/login">
        <label style={{ display: "block", marginBottom: "0.5rem" }}>
          <span>ショップドメイン</span>
          <input type="text" name="shop" placeholder="my-store.myshopify.com" style={{ display: "block", width: "100%", marginTop: "0.25rem", padding: "0.5rem" }} />
        </label>
        <button type="submit" style={{ marginTop: "0.5rem", padding: "0.5rem 1rem" }}>ログイン</button>
      </Form>
    </div>
  );
}
