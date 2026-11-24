import prisma from "../db.server";
import { getAppSetting, PRINT_SETTINGS_KEY } from "../utils/appSettings.server";
import { resolvePrintPaperWidthMm, syncPrintPaperWidthFields } from "../utils/printPaperWidth";
import { SALES_RECEIPT_SETTINGS_KEY, GIFT_LAYOUT_KEY, type SalesReceiptSettings, type GiftLayout } from "../utils/salesReceiptSettings";
import { normalizeTemplateData } from "../utils/receiptTemplateData";
import { receiptLayoutSettingKey, type ReceiptKind, type ReceiptLayout } from "./receiptLayoutSchema";
import { LAYOUT_PRINT_ENABLED_KEY, normalizePrintEnabled } from "./receiptLayoutPrint.server";
import { normalizeDesignBasics, scopedDesignBasics, SETTLEMENT_PREVIEW_KEY, type ReceiptDesignBasics } from "./receiptDesignSettings";

type Read = (key: string) => Promise<any>;
async function readBasics(kind: ReceiptKind, read: Read, template: () => Promise<any>): Promise<ReceiptDesignBasics> {
  if (kind === "sales" || kind === "gift") {
    const [sales, gift] = await Promise.all([read(SALES_RECEIPT_SETTINGS_KEY), read(GIFT_LAYOUT_KEY)]);
    return normalizeDesignBasics({ paperWidthMm: sales?.paperWidthMm, sales, gift }, kind);
  }
  const settings = await read(PRINT_SETTINGS_KEY);
  const paperWidthMm = resolvePrintPaperWidthMm(settings);
  if (kind === "receipt") {
    const row = await template();
    return normalizeDesignBasics({ paperWidthMm, receipt: row ? normalizeTemplateData(JSON.parse(row.templateJson)) : undefined }, kind);
  }
  const prefs = await read(SETTLEMENT_PREVIEW_KEY);
  return normalizeDesignBasics({ ...prefs, paperWidthMm }, kind);
}
export async function getReceiptDesignBasics(shopId: string, kind: ReceiptKind) {
  return readBasics(kind, (key) => getAppSetting(shopId, key), () => prisma.receiptTemplate.findFirst({ where: { shopId, isActive: true }, orderBy: { updatedAt: "desc" } }));
}
export class DesignSettingsConflict extends Error {}
/** 部分保存を防ぎ、共有設定を他の帳票の古い値で戻さない。外部通信なし。 */
export async function saveReceiptDesign(shopId: string, kind: ReceiptKind, layout: ReceiptLayout, enabled: boolean,
  basics?: ReceiptDesignBasics, baseline?: ReceiptDesignBasics) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const read: Read = async (key) => {
          const row = await tx.appSetting.findUnique({ where: { shopId_key: { shopId, key } } });
          return row?.valueJson ? JSON.parse(row.valueJson) : null;
        };
        const write = async (key: string, data: unknown) => {
          const valueJson = JSON.stringify(data);
          await tx.appSetting.upsert({ where: { shopId_key: { shopId, key } }, create: { shopId, key, valueJson }, update: { valueJson, updatedAt: new Date() } });
        };
        let template: Awaited<ReturnType<typeof tx.receiptTemplate.findFirst>> | undefined | null;
        const current = basics ? await readBasics(kind, read, async () => template = await tx.receiptTemplate.findFirst({ where: { shopId, isActive: true }, orderBy: { updatedAt: "desc" } })) : undefined;
        if (basics && baseline && JSON.stringify(scopedDesignBasics(current!, kind)) !== JSON.stringify(scopedDesignBasics(baseline, kind))) {
          throw new DesignSettingsConflict("別の画面で基本設定が変更されました。画面を開き直してから保存してください。");
        }
        if (basics && current && JSON.stringify(scopedDesignBasics(basics, kind)) !== JSON.stringify(scopedDesignBasics(current, kind))) {
          if (kind === "sales" || kind === "gift") {
            const saved = await read(SALES_RECEIPT_SETTINGS_KEY);
            const nextSales = kind === "sales" ? { ...saved, ...basics.sales, layoutJson: { ...saved?.layoutJson, ...basics.sales?.layoutJson }, paperWidthMm: basics.paperWidthMm }
              : { ...current.sales, ...saved, enabled: basics.sales!.enabled, paperWidthMm: basics.paperWidthMm };
            await write(SALES_RECEIPT_SETTINGS_KEY, nextSales);
            if (kind === "gift") await write(GIFT_LAYOUT_KEY, { ...await read(GIFT_LAYOUT_KEY), ...basics.gift });
          } else {
            if (basics.paperWidthMm !== current.paperWidthMm) await write(PRINT_SETTINGS_KEY, { ...await read(PRINT_SETTINGS_KEY), ...syncPrintPaperWidthFields(basics.paperWidthMm) });
            if (kind === "receipt" && JSON.stringify(basics.receipt) !== JSON.stringify(current.receipt)) {
              const data = { ...current.receipt, ...basics.receipt };
              data.showOrderNumber = data.showOrderName;
              data.showDate = data.showIssueDate;
              if (template) await tx.receiptTemplate.update({ where: { id: template.id }, data: { templateJson: JSON.stringify(data), version: { increment: 1 }, updatedAt: new Date() } });
              else await tx.receiptTemplate.create({ data: { shopId, name: data.receiptTemplateName || "デフォルトテンプレート", isActive: true, templateJson: JSON.stringify(data), version: 1 } });
            }
            if (kind === "settlement") await write(SETTLEMENT_PREVIEW_KEY, { ...await read(SETTLEMENT_PREVIEW_KEY), isInspection: basics.isInspection, showVoucherChange: basics.showVoucherChange, paperWidthMm: basics.paperWidthMm });
          }
        }
        await write(receiptLayoutSettingKey(kind), layout);
        await write(LAYOUT_PRINT_ENABLED_KEY, { ...normalizePrintEnabled(await read(LAYOUT_PRINT_ENABLED_KEY)), [kind]: enabled });
        return basics;
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if ((error as { code?: string }).code === "P2034" && attempt < 2) continue;
      throw error;
    }
  }
}
