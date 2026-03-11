/**
 * prisma/seed.ts — 開発用シードデータ
 * Epic H: 運用品質
 *
 * 使い方:
 *   npx prisma db seed
 *   または: npx ts-node --esm prisma/seed.ts
 *
 * 本番環境では実行しないこと。
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEV_SHOP_DOMAIN = "dev-store.myshopify.com";
const DEV_SHOP_GID = "gid://shopify/Shop/1";

async function main() {
  console.log("🌱 シードデータ投入開始...");

  // ── Shop ──────────────────────────────────────────────────────────────────
  const shop = await prisma.shop.upsert({
    where: { shopifyShopGid: DEV_SHOP_GID },
    update: { planCode: "pro" },
    create: {
      shopifyShopGid: DEV_SHOP_GID,
      shopDomain: DEV_SHOP_DOMAIN,
      planCode: "pro",
    },
  });
  console.log(`  ✓ Shop: ${shop.shopDomain} (${shop.id})`);

  // ── Locations ─────────────────────────────────────────────────────────────
  const locationsData = [
    {
      shopifyLocationGid: "gid://shopify/Location/1001",
      name: "新宿本店",
      code: "SHJ",
      printMode: "order_based",
      salesSummaryEnabled: true,
      footfallReportingEnabled: true,
    },
    {
      shopifyLocationGid: "gid://shopify/Location/1002",
      name: "渋谷店",
      code: "SBY",
      printMode: "cloudprnt_direct",
      salesSummaryEnabled: true,
      footfallReportingEnabled: false,
    },
    {
      shopifyLocationGid: "gid://shopify/Location/1003",
      name: "池袋店",
      code: "IKB",
      printMode: "order_based",
      salesSummaryEnabled: false,
      footfallReportingEnabled: false,
    },
  ];

  for (const loc of locationsData) {
    const location = await prisma.location.upsert({
      where: {
        shopId_shopifyLocationGid: {
          shopId: shop.id,
          shopifyLocationGid: loc.shopifyLocationGid,
        },
      },
      update: {},
      create: { shopId: shop.id, ...loc },
    });
    console.log(`  ✓ Location: ${location.name} (${location.shopifyLocationGid})`);
  }

  // ── ReceiptTemplate ───────────────────────────────────────────────────────
  const templateData = {
    companyName: "株式会社サンプル商事",
    address: "東京都新宿区西新宿1-1-1",
    phone: "03-0000-0000",
    defaultProviso: "お買上品代として",
    showOrderNumber: true,
    showDate: true,
    logoUrl: null,
  };

  const existingTemplate = await prisma.receiptTemplate.findFirst({
    where: { shopId: shop.id, isActive: true },
  });
  if (!existingTemplate) {
    const template = await prisma.receiptTemplate.create({
      data: {
        shopId: shop.id,
        name: "デフォルトテンプレート",
        isActive: true,
        templateJson: JSON.stringify(templateData),
        version: 1,
      },
    });
    console.log(`  ✓ ReceiptTemplate: ${template.name} (v${template.version})`);
  } else {
    console.log(`  → ReceiptTemplate: 既存あり (スキップ)`);
  }

  // ── Budget（新宿本店・直近3ヶ月分） ──────────────────────────────────────
  const today = new Date();
  const budgetsToSeed: { locationId: string; targetDate: string; amount: number }[] = [];

  for (let monthOffset = -1; monthOffset <= 1; monthOffset++) {
    const d = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    // 月の各日
    const daysInMonth = new Date(year, d.getMonth() + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const dayStr = String(day).padStart(2, "0");
      const targetDate = `${year}-${month}-${dayStr}`;
      // 土日は少なめ、平日は通常
      const dow = new Date(targetDate).getDay();
      const isWeekend = dow === 0 || dow === 6;
      budgetsToSeed.push({
        locationId: "gid://shopify/Location/1001",
        targetDate,
        amount: isWeekend ? 300000 : 150000,
      });
    }
  }

  let budgetCreated = 0;
  for (const b of budgetsToSeed) {
    await prisma.budget.upsert({
      where: {
        shopId_locationId_targetDate: {
          shopId: shop.id,
          locationId: b.locationId,
          targetDate: b.targetDate,
        },
      },
      update: {},
      create: {
        shopId: shop.id,
        locationId: b.locationId,
        targetDate: b.targetDate,
        amount: b.amount,
      },
    });
    budgetCreated++;
  }
  console.log(`  ✓ Budget: ${budgetCreated} 件 (新宿本店・直近3ヶ月)`);

  // ── SalesSummaryCacheDaily（新宿本店・直近7日） ───────────────────────────
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const targetDate = d.toISOString().slice(0, 10);
    const actual = 80000 + Math.floor(Math.random() * 120000);
    const orders = 20 + Math.floor(Math.random() * 30);
    const visitors = 80 + Math.floor(Math.random() * 60);

    await prisma.salesSummaryCacheDaily.upsert({
      where: {
        shopId_locationId_targetDate: {
          shopId: shop.id,
          locationId: "gid://shopify/Location/1001",
          targetDate,
        },
      },
      update: {},
      create: {
        shopId: shop.id,
        locationId: "gid://shopify/Location/1001",
        targetDate,
        actual,
        orders,
        items: orders + Math.floor(Math.random() * 20),
        visitors,
        conv: orders / visitors,
        atv: orders > 0 ? actual / orders : 0,
        budget: 150000,
        budgetRatio: actual / 150000,
      },
    });
  }
  console.log("  ✓ SalesSummaryCacheDaily: 7 件 (新宿本店・直近7日)");

  // ── FootfallReport（新宿本店・直近7日） ────────────────────────────────────
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const targetDate = d.toISOString().slice(0, 10);
    await prisma.footfallReport.upsert({
      where: {
        shopId_locationId_targetDate: {
          shopId: shop.id,
          locationId: "gid://shopify/Location/1001",
          targetDate,
        },
      },
      update: {},
      create: {
        shopId: shop.id,
        locationId: "gid://shopify/Location/1001",
        targetDate,
        visitors: 80 + Math.floor(Math.random() * 60),
        createdBy: "seed",
      },
    });
  }
  console.log("  ✓ FootfallReport: 7 件 (新宿本店・直近7日)");

  // ── Settlement（精算履歴・直近5日） ─────────────────────────────────────────
  const paymentSectionsExample = JSON.stringify([
    { gateway: "cash", label: "現金", net: 80000, refund: 5000, txCount: 15, refundCount: 2 },
    { gateway: "credit_card", label: "クレジットカード", net: 60000, refund: 0, txCount: 10, refundCount: 0 },
  ]);
  let settlementCreated = 0;
  for (let i = 4; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const targetDate = d.toISOString().slice(0, 10);
    const existing = await prisma.settlement.findUnique({
      where: {
        idempotencyKey: `${shop.id}:gid://shopify/Location/1001:${targetDate}:order_based`,
      },
    });
    if (!existing) {
      const total = 130000 + Math.floor(Math.random() * 50000);
      await prisma.settlement.create({
        data: {
          shopId: shop.id,
          locationId: "gid://shopify/Location/1001",
          targetDate,
          periodLabel: targetDate,
          currency: "JPY",
          total,
          netSales: Math.floor(total * 0.909),
          tax: Math.floor(total * 0.091),
          discounts: 3000,
          vipPointsUsed: 1000,
          refundTotal: 5000,
          orderCount: 25,
          refundCount: 2,
          itemCount: 40,
          voucherChangeAmount: 0,
          paymentSectionsJson: paymentSectionsExample,
          printMode: "order_based",
          status: "completed",
          idempotencyKey: `${shop.id}:gid://shopify/Location/1001:${targetDate}:order_based`,
        },
      });
      settlementCreated++;
    }
  }
  console.log(`  ✓ Settlement: ${settlementCreated} 件 (新宿本店・直近5日)`);

  // ── SpecialRefundEvent（特殊返金サンプル3件） ────────────────────────────────
  const sampleEvents = [
    {
      sourceOrderId: "gid://shopify/Order/1001",
      sourceOrderName: "#1001",
      locationId: "gid://shopify/Location/1001",
      eventType: "cash_refund",
      amount: 3000,
      currency: "JPY",
      originalPaymentMethod: "credit_card",
      actualRefundMethod: "cash",
      note: "顧客都合によりクレジットカード→現金返金",
      createdBy: "staff_a",
      status: "active",
    },
    {
      sourceOrderId: "gid://shopify/Order/1002",
      sourceOrderName: "#1002",
      locationId: "gid://shopify/Location/1001",
      eventType: "voucher_change_adjustment",
      amount: 500,
      currency: "JPY",
      voucherFaceValue: 5000,
      voucherAppliedAmount: 4500,
      voucherChangeAmount: 500,
      note: "商品券釣有り差額",
      createdBy: "staff_b",
      status: "active",
    },
    {
      sourceOrderId: "gid://shopify/Order/1003",
      sourceOrderName: "#1003",
      locationId: "gid://shopify/Location/1002",
      eventType: "payment_method_override",
      amount: 8000,
      currency: "JPY",
      originalPaymentMethod: "e_money",
      actualRefundMethod: "cash",
      note: "電子マネー→現金 返金手段変更",
      createdBy: "staff_c",
      status: "voided",
    },
  ];

  let refundCreated = 0;
  for (const ev of sampleEvents) {
    const existing = await prisma.specialRefundEvent.findFirst({
      where: { shopId: shop.id, sourceOrderId: ev.sourceOrderId, eventType: ev.eventType },
    });
    if (!existing) {
      await prisma.specialRefundEvent.create({
        data: { shopId: shop.id, ...ev },
      });
      refundCreated++;
    }
  }
  console.log(`  ✓ SpecialRefundEvent: ${refundCreated} 件`);

  // ── ReceiptIssue（領収書発行サンプル3件） ────────────────────────────────────
  const receiptSamples = [
    {
      orderId: "gid://shopify/Order/1001",
      orderName: "#1001",
      locationId: "gid://shopify/Location/1001",
      recipientName: "山田太郎",
      proviso: "お買上品代として",
      amount: 15000,
      currency: "JPY",
      isReissue: false,
      createdBy: "staff_a",
    },
    {
      orderId: "gid://shopify/Order/1002",
      orderName: "#1002",
      locationId: "gid://shopify/Location/1001",
      recipientName: "鈴木花子",
      proviso: "商品購入代金として",
      amount: 8500,
      currency: "JPY",
      isReissue: false,
      createdBy: "staff_b",
    },
    {
      orderId: "gid://shopify/Order/1002",
      orderName: "#1002",
      locationId: "gid://shopify/Location/1001",
      recipientName: "鈴木花子",
      proviso: "商品購入代金として",
      amount: 8500,
      currency: "JPY",
      isReissue: true,
      createdBy: "staff_a",
    },
  ];

  let receiptCreated = 0;
  for (const r of receiptSamples) {
    const existing = await prisma.receiptIssue.findFirst({
      where: { shopId: shop.id, orderId: r.orderId, isReissue: r.isReissue },
    });
    if (!existing) {
      await prisma.receiptIssue.create({
        data: { shopId: shop.id, ...r },
      });
      receiptCreated++;
    }
  }
  console.log(`  ✓ ReceiptIssue: ${receiptCreated} 件`);

  console.log("\n✅ シードデータ投入完了");
}

main()
  .catch((e) => {
    console.error("❌ シードエラー:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
