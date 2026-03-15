/**
 * 開発環境で確実に最新コードが動くように、キャッシュ削除 → ビルド → dev 起動を行う。
 * 使い方: npm run dev:clean
 */
import { rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const dirsToRemove = ["build", ".vite", "node_modules/.vite"];

console.log("[dev:clean] キャッシュ・ビルド成果物を削除しています...\n");
for (const d of dirsToRemove) {
  const p = join(root, d);
  if (existsSync(p)) {
    rmSync(p, { recursive: true });
    console.log(`  削除: ${d}`);
  }
}

console.log("\n[dev:clean] ビルドを実行しています...\n");
execSync("npm run build", { cwd: root, stdio: "inherit" });

console.log("\n[dev:clean] 開発サーバーを起動します。表示された URL から管理画面 → POS を開いてください。\n");
spawn("npm", ["run", "dev"], { cwd: root, stdio: "inherit", shell: true });
