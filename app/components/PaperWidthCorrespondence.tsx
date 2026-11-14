import { Link } from "react-router";
import { BlockStack } from "@shopify/polaris";
import {
  paperStripPercent,
  paperWidthUses,
  type PaperMm,
} from "../utils/paperWidthCorrespondence";

type PaperWidthCorrespondenceProps = {
  sharedWidthMm: PaperMm;
  salesWidthMm: PaperMm;
  search: string;
  /** プレビュー画面では、保存先が印字設定であることを添える */
  saveNote?: string;
};

export function PaperWidthCorrespondence({
  sharedWidthMm,
  salesWidthMm,
  search,
  saveNote,
}: PaperWidthCorrespondenceProps) {
  const rows = paperWidthUses({ sharedWidthMm, salesWidthMm });
  const query = search && !search.startsWith("?") ? `?${search}` : search || "";

  return (
    <BlockStack gap="300">
      <p className="AdminPaper-note">
        選択中の印字設定は {sharedWidthMm}mm です。精算・点検・領収書はこの幅を使います。販売レシートは{" "}
        {salesWidthMm}mm で、販売レシート設定に保存されています。
      </p>
      {saveNote ? <p className="AdminPaper-note">{saveNote}</p> : null}
      <div className="AdminPaper-bars" aria-hidden="true">
        {([58, 80] as const).map((mm) => (
          <div
            key={mm}
            className={mm === sharedWidthMm ? "AdminPaper-bar is-selected" : "AdminPaper-bar"}
          >
            <div className="AdminPaper-strip" style={{ width: `${paperStripPercent(mm)}%` }} />
            <span>
              {mm}mm{mm === sharedWidthMm ? "（印字設定）" : ""}
            </span>
          </div>
        ))}
      </div>
      <p className="AdminPaper-caption">帯の長さは 80mm を基準にした比率です。帳票の中身は各プレビューで確認します。</p>
      <table className="AdminPaper-map">
        <thead>
          <tr>
            <th scope="col">帳票</th>
            <th scope="col">設定の場所</th>
            <th scope="col">幅</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.document} className={row.shared ? "is-shared" : undefined}>
              <td>{row.document}</td>
              <td>
                {row.settingName}
                <div>
                  <Link to={`${row.href}${query}`}>{row.linkLabel}</Link>
                </div>
              </td>
              <td>{row.widthMm}mm</td>
            </tr>
          ))}
        </tbody>
      </table>
    </BlockStack>
  );
}
