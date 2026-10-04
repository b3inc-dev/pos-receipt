#!/usr/bin/env node
/**
 * Preview 専用 worktree を安全に準備する。
 * 使い方（main worktree から）: npm run preview:setup
 *
 * - 既定パス: ../ciara-system-preview（repo 名が pos-receipt でもこの名前を既定にする）
 * - 上書き: PREVIEW_WORKTREE_PATH または .preview-worktree.path
 * - 既存なら再利用。二重作成しない。dirty なら破棄せず停止。
 * - 本体（呼び出し元）の branch は切り替えない。
 */
import {
  DEFAULT_PREVIEW_RELATIVE_PATH,
  ensurePreviewWorktree,
  findMainRepoRoot,
  log,
  logOk,
  PREVIEW_PORT,
  PREVIEW_URL,
  printPreviewNextSteps,
  resolvePreviewPath,
  withPreviewErrors,
} from "./preview-lib.mjs";

withPreviewErrors(() => {
  const mainRoot = findMainRepoRoot();
  const previewPath = resolvePreviewPath(mainRoot);

  log("=== PR Preview setup ===");
  log(`main worktree : ${mainRoot}`);
  log(`preview path  : ${previewPath}`);
  log(`default rel   : ${DEFAULT_PREVIEW_RELATIVE_PATH}`);
  log(`preview URL   : ${PREVIEW_URL} (port ${PREVIEW_PORT})`);
  log("");

  const result = ensurePreviewWorktree(mainRoot, previewPath);
  if (!result.created) {
    logOk("setup 完了（再利用）");
  } else {
    logOk("setup 完了（新規作成）");
  }

  log("");
  log("パスの理由: ユーザー指定の sibling 名 ciara-system-preview を既定にし、");
  log("repo ディレクトリ名（pos-receipt 等）と独立してプレビュー場所を固定する。");
  log("変更する場合は PREVIEW_WORKTREE_PATH または .preview-worktree.path を使う。");

  printPreviewNextSteps(previewPath);
  log("初回のあと PR を載せる:");
  log("  npm run preview:pr -- <PR番号>   # main 側で実行");
});
