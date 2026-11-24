import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { defaultLayout } from "./receiptLayoutPresets";
import { normalizeDesignBasics, validateDesignBasics } from "./receiptDesignSettings";
import { normalizeTemplateData } from "../utils/receiptTemplateData";

let store = new Map<string, unknown>();
let template: any = null;
let failKey = "";
let conflicts = 0;
let writes: string[] = [];
const db: any = {
  appSetting: {
    findUnique: async ({where}: any) => {const v=store.get(where.shopId_key.key);return v===undefined ? null : {valueJson:JSON.stringify(v)};},
    upsert: async ({create}: any) => {writes.push(create.key);if(create.key===failKey)throw Error("write failure");store.set(create.key,JSON.parse(create.valueJson));},
  },
  receiptTemplate: {
    findFirst: async () => template,
    create: async ({data}: any) => {template={id:"tmpl",...data};},
    update: async ({data}: any) => {template={...template,...data,version:template.version+1};},
  },
};
db.$transaction = async (work: any) => {
  if(conflicts-->0)throw Object.assign(Error("retry"),{code:"P2034"});
  const before=structuredClone(store), old=structuredClone(template);
  try{return await work(db);}catch(e){store=before;template=old;throw e;}
};
mock.module("../db.server",{defaultExport:db});
mock.module("../shopify.server",{namedExports:{authenticate:{admin:async()=>({admin:{},session:{shop:"test"}})}}});
mock.module("../utils/shopResolver.server",{namedExports:{resolveShop:async()=>({id:"shop"})}});
const {getReceiptDesignBasics,saveReceiptDesign,DesignSettingsConflict}=await import("./receiptDesignSettings.server");
const layout=defaultLayout("sales");
function reset(){store=new Map();template=null;writes=[];failKey="";conflicts=0;}

test("従来の販売/ギフト/領収書と実際の用紙幅を読み、開くだけでは何も書かない",async()=>{
 reset();store.set("sales_receipt_settings",{enabled:false,paperWidthMm:58,headerTitle:"保存済み",layoutJson:{showSku:true}});
 store.set("gift_receipt_layout",{title:"贈り物",footer:"保存済み",showOrderNumber:false});
 store.set("print_settings",{paperWidthMm:58,receiptPrinterProfile:"mcp31lb_58"});
 template={id:"tmpl",version:7,templateJson:JSON.stringify({...normalizeTemplateData(null),companyName:"保存済み会社",unknown:"keep"})};
 const sales=await getReceiptDesignBasics("shop","sales"),gift=await getReceiptDesignBasics("shop","gift"),receipt=await getReceiptDesignBasics("shop","receipt");
 assert.equal(sales.sales?.enabled,false);assert.equal(sales.sales?.headerTitle,"保存済み");assert.equal(gift.gift?.title,"贈り物");assert.equal(receipt.receipt?.companyName,"保存済み会社");
 assert.equal(receipt.paperWidthMm,58);assert.equal((receipt.receipt as any).unknown,"keep");assert.deepEqual(writes,[]);assert.equal(template.version,7);
});
test("デザインと基本設定は一括保存。別帳票の有効設定/機器補正/未知の保存項目を保持",async()=>{
 reset();store.set("receipt_layout_print_v1",{gift:true,receipt:true});store.set("sales_receipt_settings",{unknown:"keep"});
 const before=await getReceiptDesignBasics("shop","sales"),next=structuredClone(before);next.paperWidthMm=58;next.sales!.paperWidthMm=58;next.sales!.enabled=false;
 await saveReceiptDesign("shop","sales",layout,true,next,before);
 assert.equal((store.get("sales_receipt_settings") as any).unknown,"keep");assert.equal((store.get("sales_receipt_settings") as any).enabled,false);
 assert.deepEqual(store.get("receipt_layout_print_v1"),{settlement:false,receipt:true,sales:true,gift:true});
 assert.deepEqual(store.get("receipt_layout_v1_sales"),layout);
});
test("ギフトの保存で、別画面が変更した販売見出しを古い値で戻さない",async()=>{
 reset();const before=await getReceiptDesignBasics("shop","gift"),next=structuredClone(before);next.gift!.title="ギフト変更";
 store.set("sales_receipt_settings",{...before.sales,headerTitle:"別画面で変更済み"});
 await saveReceiptDesign("shop","gift",defaultLayout("gift"),false,next,before);
 assert.equal((store.get("sales_receipt_settings") as any).headerTitle,"別画面で変更済み");
 assert.equal((store.get("gift_receipt_layout") as any).title,"ギフト変更");
});
test("領収書初期値/発行元を保存、別帳票共有の用紙幅と機器設定を保持。原本には触れない",async()=>{
 reset();store.set("print_settings",{paperWidthMm:80,receiptPrinterProfile:"mcp31lb_58",receiptPreviewBeforePrintRequired:false});
 const before=await getReceiptDesignBasics("shop","receipt"),next=structuredClone(before);next.receipt!.companyName="新会社";next.receipt!.showIssueDate=false;next.receipt!.showDate=false;next.paperWidthMm=58;
 await saveReceiptDesign("shop","receipt",defaultLayout("receipt"),false,next,before);
 assert.equal(JSON.parse(template.templateJson).companyName,"新会社");assert.equal(JSON.parse(template.templateJson).showDate,false);
 assert.equal((store.get("print_settings") as any).receiptPrinterProfile,"mcp31lb_58");assert.equal((store.get("print_settings") as any).receiptPreviewBeforePrintRequired,false);
 const unchanged=await getReceiptDesignBasics("shop","receipt");await saveReceiptDesign("shop","receipt",defaultLayout("receipt"),false,unchanged,unchanged);assert.equal(template.version,1);
});
test("共有設定の競合・書込み途中の失敗は一切の部分保存を残さない",async()=>{
 reset();const before=await getReceiptDesignBasics("shop","sales"),next=structuredClone(before);next.sales!.headerTitle="変更";
 store.set("sales_receipt_settings",{...before.sales,footerNote:"別の変更"});
 await assert.rejects(()=>saveReceiptDesign("shop","sales",layout,true,next,before),DesignSettingsConflict);assert.equal(store.has("receipt_layout_v1_sales"),false);
 reset();failKey="receipt_layout_print_v1";await assert.rejects(()=>saveReceiptDesign("shop","sales",layout,true,next,before),/write failure/);assert.equal(store.size,0);
});
test("直列化競合は上限付きで再試行。基本設定の誤りは保存前に検出",async()=>{
 reset();conflicts=1;await saveReceiptDesign("shop","sales",layout,false);assert.ok(store.has("receipt_layout_v1_sales"));
 const bad=normalizeDesignBasics({},"gift");bad.gift!.title="";assert.ok(validateDesignBasics(bad,"gift").length);
 assert.ok(validateDesignBasics({paperWidthMm:70},"receipt").length);
});
test("旧5URLは埋め込み用queryを維持して統合先へ移る",async()=>{
 for(const [file,kind] of [["sales-receipt-layout","sales"],["sales-receipt-settings","sales"],["receipt-template","receipt"],["receipt-print-layout","receipt"],["settlement-print-layout","settlement"]]){
  const mod=await import(`../routes/app.${file}.tsx`);const res=await mod.loader({request:new Request("https://test.local/app/"+file+"?shop=test&host=embedded"),params:{},context:{}});
  assert.equal(res.status,302);assert.equal(res.headers.get("Location"),`/app/receipt-layouts/${kind}?shop=test&host=embedded`);
 }
});
