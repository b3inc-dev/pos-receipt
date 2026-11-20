import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPureFunctions } from './pure-source.mjs';

const time = loadPureFunctions('app/utils/shopTimezone.server.ts', [
  'getDayStartUtc', 'getDayEndUtc', 'getDayRangeInUtc', 'getCalendarDateStringInTimeZone', 'formatTimeHmInTimeZone',
]);
const { buildSettlementReceiptText: render } = loadPureFunctions('app/services/settlementEngine.server.ts', ['buildSettlementReceiptText']);
const { serializeOrderDetail } = loadPureFunctions('app/services/orderDetail.server.ts', [
  'moneyAmount', 'moneyCurrency', 'transactionDisplayName', 'discountApplicationLabel', 'serializeOrderDetail',
], { formatTimeHmInTimeZone: time.formatTimeHmInTimeZone });
const fixture = JSON.parse(readFileSync(new URL('./fixtures/settlement.json', import.meta.url), 'utf8'));
const money = amount => ({ shopMoney: { amount, currencyCode: 'JPY' } });

test('settlement text preserves complete sample format and line order', () => {
  const expected = readFileSync(new URL('./fixtures/settlement.txt', import.meta.url), 'utf8').replace(/\n$/, '');
  assert.equal(render(fixture), expected);
});
test('voucher change and refund details retain amounts and counts', () => {
  const text = render({ ...fixture, voucherChangeAmount: 100, refundTotal: 200, refundCount: 1,
    paymentSections: [{ label: '現金', net: 10800, txCount: 2, refund: 200, refundCount: 1 }] });
  assert.ok(text.includes('返金: ¥200\n件数: 2件 (返金1件)'));
  assert.ok(text.includes('商品券釣有り差額: ¥100'));
  assert.ok(text.endsWith('現金: ¥10,800 (2件) 返金1件 ¥200'));
});
test('empty settlement stays printable without voucher or payment lines', () => {
  const text = render({ ...fixture, total: 0, netSales: 0, tax: 0, discounts: 0, orderCount: 0, itemCount: 0, paymentSections: [] });
  assert.ok(text.includes('件数: 0件 (返金0件)'));
  assert.ok(!text.includes('商品券釣有り差額'));
  assert.ok(!text.includes('undefined'));
});
test('order details retain shop location, staff, named discounts and discount total', () => {
  const order = { id: 'gid://shopify/Order/1', name: '#TEST', createdAt: '2026-10-03T15:01:00Z',
    retailLocation: { id: 'gid://shopify/Location/1', name: '検証店舗' }, totalDiscountsSet: money('500'),
    lineItems: { nodes: [{ title: '検証商品', name: '検証商品', quantity: 1, originalUnitPriceSet: money('1500'),
      discountedUnitPriceSet: money('1000'), staffMember: { name: '検証担当' },
      discountAllocations: [
        { allocatedAmountSet: money('200'), discountApplication: { __typename: 'DiscountCodeApplication', code: 'TEST-200' } },
        { allocatedAmountSet: money('100'), discountApplication: { __typename: 'ManualDiscountApplication', title: '店頭値引' } },
        { allocatedAmountSet: money('200'), discountApplication: { __typename: 'AutomaticDiscountApplication', title: '自動値引' } },
      ] }] } };
  const out = serializeOrderDetail(order);
  assert.equal(out.location.name, '検証店舗');
  assert.equal(out.lineItems[0].staffMemberName, '検証担当');
  assert.equal(out.totalDiscounts.amount, '500');
  assert.equal(out.lineItems[0].discounts.map(d => d.label).join('|'), 'TEST-200|店頭値引|自動値引');
  assert.equal(out.transactionTime, '00:01');
  const unnamed = structuredClone(order); unnamed.lineItems.nodes[0].staffMember = null;
  assert.equal(serializeOrderDetail(unnamed).lineItems[0].staffMemberName, '');
});
test('Tokyo calendar date and day bounds preserve midnight and month boundary', () => {
  const range = time.getDayRangeInUtc('2026-10-01', 'Asia/Tokyo');
  assert.equal(range.startUtcIso, '2026-09-30T15:00:00Z');
  assert.equal(range.endUtcIso, '2026-10-01T14:59:59.999Z');
  assert.equal(time.getCalendarDateStringInTimeZone(new Date('2026-09-30T14:59:59Z'), 'Asia/Tokyo'), '2026-09-30');
  assert.equal(time.getCalendarDateStringInTimeZone(new Date('2026-09-30T15:00:00Z'), 'Asia/Tokyo'), '2026-10-01');
});
