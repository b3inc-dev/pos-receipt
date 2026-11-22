#!/usr/bin/env node
/**
 * DB の planCode が Pro（または unlimited）なのに、Shopify に有効な Pro の契約が無い店を一覧にする（読むだけ）。
 * 使い方（Render の公開用 pos-receipt の Shell）: npx tsx scripts/report-plan-mismatch.mjs
 *   --json          JSON で出す
 *   --shop=<domain> 1 店だけ見る
 * 手順: docs/PLAN_MISMATCH_REPORT.md
 */
import { buildPlanMismatchReport, formatPlanMismatchReport } from "./lib/planMismatch.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const shopArg = args.find((a) => a.startsWith("--shop="));
const onlyShop = shopArg ? shopArg.slice("--shop=".length).trim().toLowerCase() || null : null;

if (String(process.env.APP_DISTRIBUTION ?? "").trim().toLowerCase() === "inhouse") {
  console.log("自社用（APP_DISTRIBUTION=inhouse・Ciara）は請求なし・全機能なので、調べるものはありません。何もしません。");
  process.exit(0);
}

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();
try {
  const report = await buildPlanMismatchReport({ prisma, env: process.env, onlyShop });
  console.log(asJson ? JSON.stringify(report, null, 2) : formatPlanMismatchReport(report));
} catch (e) {
  console.error("[report-plan-mismatch] failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
