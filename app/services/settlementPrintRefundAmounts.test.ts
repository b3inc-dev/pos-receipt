import assert from "node:assert/strict";
import {test} from "node:test";
import {settlementTemplateData} from "./receiptLayoutAdapters";
import {CIARA_SETTLEMENT_CALC,DEFAULT_SETTLEMENT_CALC,orderSettlementPayments,settlementCashDeposit,type SettlementSectionInput} from "./receiptLayoutSettlementCalc";
import {defaultLayout,ciaraSettlementLayout} from "./receiptLayoutPresets";
import {renderLayoutForPrint} from "./receiptLayoutPrint.server";
import {renderPrintReceiptHtml,settlementPreviewToPrintModel} from "./printReceiptHtml";
const sections: SettlementSectionInput[] = [
 {label:"現金",net:57643,refund:22880,txCount:5,refundCount:2},
 {label:"クレジットカード",net:1650,refund:0,txCount:1,refundCount:0},
 {label:"wespoアプリポイント",net:1174,refund:0,txCount:1,refundCount:0},
];
const figures={total:37587,netSales:34170,tax:3417,discounts:913,vipPointsUsed:0,refundTotal:22880,orderCount:4,refundCount:2,itemCount:22,voucherChangeAmount:0};
const input={figures,sections,title:"点検",targetDate:"2026-11-25",locationId:"gid://shopify/Location/84233584886",locationName:"Ciara梅田エスト店",location:{name:"Ciara梅田エスト店",zip:"",address_lines:[],phone:""},shopName:"Ciara",currency:"JPY",issuedAt:"2026-11-25T04:12:08Z",printedAt:"2026-11-25T07:00:00Z",timezone:"Asia/Tokyo",calc:DEFAULT_SETTLEMENT_CALC};

test("梅田の実例: 支払別の返金後合計と総売上が一致し、保存値を変えず納金34763円",()=>{
 const before=structuredClone(input);
 for(const isInspection of [true,false]){
  const data=settlementTemplateData({...input,isInspection});assert.equal(data.kind,"settlement");if(data.kind!=="settlement")throw Error("kind");
  assert.equal(data.settlement.payments[0].net,34763);assert.equal(data.settlement.payments[0].refund,22880);
  assert.equal(data.settlement.cash_deposit,34763);assert.equal(data.settlement.payments.reduce((sum,p)=>sum+p.net,0),37587);
  assert.equal(data.settlement.total,37587);assert.equal(data.settlement.total_including_returns,60467);assert.equal(data.settlement.net_sales,34170);assert.equal(data.settlement.tax,3417);assert.equal(data.settlement.refund_count,2);
 }
 assert.deepEqual(input,before);
});
test("標準ブロック・Ciaraブロック・編集コード・旧標準の印字で同じ返金後金額になる",()=>{
 const data=settlementTemplateData({...input,isInspection:true});
 const code={...defaultLayout("settlement"),mode:"code" as const,code:'<p>納金額 {{ settlement.cash_deposit | money }}</p>{% for p in settlement.payments %}<p>{{ p.label }} {{ p.net | money }} 返金 {{ p.refund | money }}</p>{% endfor %}'};
 for(const width of [58,80] as const){
  for(const layout of [defaultLayout("settlement"),ciaraSettlementLayout(),code]){
   const html=renderLayoutForPrint(layout,data,width)!;assert.ok(html.includes("¥34,763"));assert.ok(html.includes("¥22,880"));assert.ok(!html.includes("¥57,643"));assert.ok(!html.includes("-¥22,880"));
  }
  const html=renderPrintReceiptHtml(settlementPreviewToPrintModel({...figures,targetDate:input.targetDate,locationName:input.locationName,paymentSections:sections},{paperWidthMm:width}));
  assert.ok(html.includes("¥34,763"));assert.ok(!html.includes("¥57,643"));assert.ok(!html.includes("-¥22,880"));assert.ok(html.includes("¥22,880"));
 }
});
test("現金以外も共通の契約で返金後の取引額へ。全額返金・返金だけの日も失わない",()=>{
 for(const label of ["現金","クレジットカード","電子マネー(QR)","交通系ICカード決済","商品券釣無し","wespoアプリポイント","STACIAポイント","独自決済"]){
  const rows=orderSettlementPayments([{label,net:1000,refund:250,txCount:1,refundCount:1},{label:"全額返金",net:500,refund:500,txCount:1,refundCount:1},{label:"過去の売上の返金",net:0,refund:300,txCount:0,refundCount:1}],DEFAULT_SETTLEMENT_CALC);
  assert.deepEqual(rows.map(p=>[p.net,p.refund]),[[750,250],[0,500],[-300,300]],label);
 }
 const rows=orderSettlementPayments([{label:"電子マネー(QR)",net:1000,refund:200,txCount:1,refundCount:1},{label:"交通系ICカード決済",net:500,refund:100,txCount:1,refundCount:1}],CIARA_SETTLEMENT_CALC);
 assert.equal(rows.find(p=>p.is_group)?.net,1200);assert.equal(rows.find(p=>p.is_group)?.refund,300);
});
test("納金: 現金返金・指定返金・商品券釣りを各1回。指定に現金が重なっても二重に引かない",()=>{
 const data=[{label:"現金",net:10000,refund:2000,txCount:2,refundCount:1},{label:"WESPOアプリポイント",net:1000,refund:300,txCount:1,refundCount:1},{label:"クレジットカード",net:5000,refund:700,txCount:1,refundCount:1}];
 const opts={locationId:input.locationId,locationName:input.locationName,voucherChange:100};
 assert.equal(settlementCashDeposit(data,{...opts,calc:DEFAULT_SETTLEMENT_CALC}),7900);
 assert.equal(settlementCashDeposit(data,{...opts,calc:CIARA_SETTLEMENT_CALC}),7600);
 assert.equal(settlementCashDeposit(data,{...opts,calc:{...CIARA_SETTLEMENT_CALC,refundDeductMethods:["現金","wespo"]}}),7600);
 assert.equal(settlementCashDeposit([{label:"現金",net:0,refund:500,txCount:0,refundCount:1}],{...opts,voucherChange:0,calc:DEFAULT_SETTLEMENT_CALC}),-500);
});
