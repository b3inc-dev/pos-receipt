import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
const read=p=>readFileSync(p,'utf8');
test('全ページのグループタブはカードの外枠を持たず、共通部品の余白を使う',()=>{
 for(const name of readdirSync('app/routes').filter(n=>n.endsWith('.tsx'))){const s=read('app/routes/'+name);assert.doesNotMatch(s,/<Card\b[^>]*>\s*<TabGroupBar\b/,name);}
 assert.match(read('app/components/TabGroupBar.tsx'),/Admin-group-tabs/);
});
test('帳票入口はレシート、レポート入口は集計しない一覧、精算メニューに印字を重複しない',()=>{
 const tabs=read('app/components/TabGroupBar.tsx');const settlement=tabs.slice(tabs.indexOf('export const SETTLEMENT_TABS'),tabs.indexOf('/** 3. 店舗'));
 assert.doesNotMatch(settlement,/print-layout|receipt-layout|印字|デザイン/);
 for(const s of [read('app/components/AppNavBar.tsx'),read('app/routes/app.tsx')]){assert.match(s,/\/app\/receipt-layouts/);assert.match(s,/\/app\/reports/);}
 assert.match(tabs,/店舗一覧/);assert.doesNotMatch(tabs,/label: "販売レイアウト"|label: "領収書テンプレート"|label: "領収書印字プレビュー"/);
});
