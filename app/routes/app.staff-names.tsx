/**
 * /app/staff-names — スタッフ名（販売の帰属スタッフの表示名）
 *
 * Shopify POS で明細に付いた帰属スタッフは、注文の通知からスタッフ ID だけが届く（名前は届かない）。
 * ここで ID ごとに表示名を登録し、領収書の発行者・注文の詳細などに出す（T 2026-11-23 の決定）。
 * read_users がある店では Shopify の名前が優先され、ここの登録は名前が引けないときに使う。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useLocation, useNavigate, useNavigation } from "react-router";
import { Page, Layout, Card } from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { setAppSetting } from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, STORE_TABS } from "../components/TabGroupBar";
import {
  AdminIntro,
  DeleteIconButton,
  EditCell,
  EditRow,
  EditTable,
  SaveBar,
  StatusBanner,
  SuccessToast,
  markFormDirty,
} from "../components/admin-ui";
import { listRecordedStaffIds, loadStaffDisplayNames } from "../services/orderStaffAttribution.server";
import {
  STAFF_DISPLAY_NAMES_KEY,
  STAFF_DISPLAY_NAMES_MAX,
  buildStaffDisplayNames,
  scopeIncludesReadUsers,
  type StaffNameRowError,
} from "../utils/attributedStaff";

type Row = { key: string; staffId: string; name: string; recorded: boolean };

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const [names, recordedIds] = await Promise.all([loadStaffDisplayNames(shop.id), listRecordedStaffIds(shop.id)]);
  const recorded = new Set(recordedIds);
  // 並び: 記録に出てきた順（新しい順）→ 登録だけある ID（数の小さい順）
  const ids = [...recordedIds, ...Object.keys(names).filter((id) => !recorded.has(id)).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))];
  const rows = ids.map((id) => ({ staffId: id, name: names[id] ?? "", recorded: recorded.has(id) }));
  return { rows, hasReadUsers: scopeIncludesReadUsers(session.scope) };
}

type ActionResult = { ok: true; savedAt: number } | { ok: false; errors: StaffNameRowError[] };

export async function action({ request }: ActionFunctionArgs): Promise<ActionResult> {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const form = await request.formData();
  const ids = form.getAll("staffId").map(String);
  const names = form.getAll("name").map(String);
  const rows = ids.map((staffId, i) => ({ staffId, name: names[i] ?? "" }));
  const { value, errors } = buildStaffDisplayNames(rows);
  if (errors.length > 0) return { ok: false, errors };
  await setAppSetting(shop.id, STAFF_DISPLAY_NAMES_KEY, value);
  return { ok: true, savedAt: Date.now() };
}

let rowSeq = 0;
const nextKey = () => `r${++rowSeq}`;

export default function StaffNamesPage() {
  const { rows: initial, hasReadUsers } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const toRows = () => initial.map((r) => ({ ...r, key: nextKey() }));
  const [rows, setRows] = useState<Row[]>(toRows);
  const failed = actionData?.ok === false && navigation.state === "idle";

  const addRow = (e: React.MouseEvent<HTMLButtonElement>) => {
    const target = e.currentTarget;
    setRows((prev) => [...prev, { key: nextKey(), staffId: "", name: "", recorded: false }]);
    window.requestAnimationFrame(() => markFormDirty(target));
  };
  const removeRow = (key: string, el: Element | null) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
    window.requestAnimationFrame(() => markFormDirty(el));
  };

  return (
    <PolarisPageWrapper>
      <Page title="スタッフ名" backAction={{ content: "ホーム", onAction: () => navigate("/app" + q) }}>
        <Card padding="0">
          <TabGroupBar tabs={STORE_TABS} />
        </Card>
        <Form method="post" id="staff-names-form">
          {/* 保存は Shopify の保存の帯だけ。成功は保存のたびにトースト、失敗は下のお知らせ枠 1 つ（UI ルール v1.1 7章） */}
          <SaveBar failed={failed} tone={failed ? "critical" : "success"} onDiscard={() => setRows(toRows())} />
          <SuccessToast message={actionData?.ok ? "保存しました" : null} trigger={actionData} />
          <Layout>
            <Layout.Section>
              <AdminIntro>
                <p>
                  POS で販売に付いたスタッフ（帰属スタッフ）の名前を登録します。注文の通知にはスタッフ ID だけが届くので、ここで ID ごとに名前を付けると、領収書の発行者や注文の詳細に名前で出ます。
                  {hasReadUsers ? " この店は Shopify のスタッフ名が読めるため、そちらを優先し、読めないときにここの名前を使います。" : ""}
                </p>
              </AdminIntro>
            </Layout.Section>
            {failed ? (
              <Layout.Section>
                <StatusBanner tone="critical" heading="保存できませんでした">
                  <ul>
                    {actionData.errors.map((e, i) => (
                      <li key={i}>{e.message}</li>
                    ))}
                  </ul>
                </StatusBanner>
              </Layout.Section>
            ) : null}
            <Layout.Section>
              <Card>
                <div className="Admin-form">
                  {rows.length === 0 ? (
                    <p className="Admin-note">
                      まだ帰属スタッフの記録がありません。POS で帰属スタッフを付けて会計すると、ここにスタッフ ID が出ます。
                    </p>
                  ) : null}
                  <EditTable
                    columns={[
                      { label: "スタッフ ID", width: "minmax(120px, 1fr)" },
                      { label: "表示名", width: "minmax(160px, 2fr)" },
                      { label: "", width: "40px" },
                    ]}
                  >
                    {rows.map((r) => (
                      <EditRow key={r.key}>
                        <EditCell label="スタッフ ID">
                          {r.recorded ? (
                            <>
                              <input type="hidden" name="staffId" value={r.staffId} />
                              <span>{r.staffId}</span>
                            </>
                          ) : (
                            <input
                              className="Admin-input"
                              name="staffId"
                              inputMode="numeric"
                              aria-label="スタッフ ID"
                              defaultValue={r.staffId}
                              pattern="\d{1,20}"
                              required
                            />
                          )}
                        </EditCell>
                        <EditCell label="表示名" wide>
                          <input
                            className="Admin-input"
                            name="name"
                            aria-label={`スタッフ ID ${r.staffId || "（新しい行）"} の表示名`}
                            defaultValue={r.name}
                            maxLength={60}
                            placeholder="例: 山田"
                          />
                        </EditCell>
                        <EditCell label="" end>
                          {r.recorded ? null : (
                            <span>
                              <DeleteIconButton
                                label="この行を消す"
                                onClick={() => removeRow(r.key, document.getElementById("staff-names-form"))}
                              />
                            </span>
                          )}
                        </EditCell>
                      </EditRow>
                    ))}
                  </EditTable>
                  <div className="Admin-copy-action">
                    <button
                      type="button"
                      className="Admin-secondary"
                      onClick={addRow}
                      disabled={rows.length >= STAFF_DISPLAY_NAMES_MAX}
                    >
                      スタッフを追加
                    </button>
                  </div>
                  <p className="Admin-note">名前を空にして保存すると、その ID の登録を消します（記録は消えません）。</p>
                </div>
              </Card>
            </Layout.Section>
          </Layout>
        </Form>
      </Page>
    </PolarisPageWrapper>
  );
}
