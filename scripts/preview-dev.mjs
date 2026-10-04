#!/usr/bin/env node
/**
 * Preview worktree 上で開発サーバーをポート 3001 固定で起動する。
 * 使い方:
 *   cd ../ciara-system-preview && npm run preview:dev
 *   または main 側から: npm run preview:dev（preview path を解決して起動）
 *
 * 通常の npm run dev（3000）と競合しない。常駐デーモン化はしない。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  findMainRepoRoot,
  gitOutput,
  listWorktrees,
  log,
  logOk,
  PREVIEW_BRANCH,
  PREVIEW_PORT,
  PREVIEW_URL,
  PreviewError,
  readPreviewState,
  resolvePreviewPath,
  withPreviewErrors,
} from "./preview-lib.mjs";

function resolvePreviewDevPath(startDir = process.cwd()) {
  const currentRoot = findMainRepoRoot(startDir);
  const branch = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], currentRoot);
  const hasMarker = Boolean(readPreviewState(currentRoot));

  // preview worktree 内から実行された場合
  if (branch === PREVIEW_BRANCH || hasMarker) {
    return currentRoot;
  }

  // main などから実行: 設定パスを解決。いずれかの worktree を起点に試す。
  const worktrees = listWorktrees(currentRoot);
  const roots = [currentRoot, ...worktrees.map((w) => w.path)];
  for (const root of roots) {
    const candidate = resolvePreviewPath(root);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return resolvePreviewPath(currentRoot);
}

withPreviewErrors(() => {
  const previewPath = resolvePreviewDevPath();

  if (!existsSync(previewPath)) {
    throw new PreviewError(
      `Preview worktree がありません: ${previewPath}\n先に npm run preview:setup と npm run preview:pr -- <PR番号> を実行してください。`,
    );
  }

  log("=== PR Preview dev ===");
  log(`cwd   : ${previewPath}`);
  log(`URL   : ${PREVIEW_URL}`);
  log(`port  : ${PREVIEW_PORT}（通常 dev の 3000 とは分離）`);
  log("");
  logOk("shopify app dev を --use-localhost --localhost-port 3001 で起動します");
  log("停止: Ctrl+C（常駐サービス化はしません）");
  log("");

  const env = {
    ...process.env,
    PORT: String(PREVIEW_PORT),
    SHOPIFY_FLAG_LOCALHOST_PORT: String(PREVIEW_PORT),
  };

  const child = spawn(
    "npx",
    [
      "shopify",
      "app",
      "dev",
      "--use-localhost",
      "--localhost-port",
      String(PREVIEW_PORT),
      "--no-update",
    ],
    {
      cwd: previewPath,
      env,
      stdio: "inherit",
      shell: false,
    },
  );

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
});
