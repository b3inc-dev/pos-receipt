#!/usr/bin/env node
/**
 * Preview worktree を指定 PR の最新 HEAD に切り替える。
 * 使い方（main worktree から）: npm run preview:pr -- <PR番号>
 *
 * - main worktree の branch / working tree は変更しない
 * - preview が dirty なら破棄せず停止
 * - 存在しない PR は明確なエラー
 * - gh 優先、失敗時は refs/pull/<n>/head
 * - db push / migrate / 本番DB は絶対に実行しない
 */
import {
  assertCleanWorktree,
  assertPreviewWorktree,
  checkoutPreviewAtSha,
  findMainRepoRoot,
  log,
  logOk,
  PreviewError,
  printPreviewNextSteps,
  reportPostCheckoutHints,
  resolvePreviewPath,
  resolvePullRequestHead,
  runGit,
  withPreviewErrors,
} from "./preview-lib.mjs";

function parsePrNumber(argv) {
  // npm run preview:pr -- 27  / node scripts/preview-pr.mjs 27
  const args = argv.slice(2).filter((a) => a !== "--");
  if (args.length === 0) {
    return null;
  }
  return args[0];
}

withPreviewErrors(() => {
  const prArg = parsePrNumber(process.argv);
  if (prArg == null) {
    throw new PreviewError(
      "使い方: npm run preview:pr -- <PR番号>\n例: npm run preview:pr -- 27",
    );
  }

  const mainRoot = findMainRepoRoot();
  const mainBranchBefore = runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: mainRoot,
  }).stdout;
  const mainHeadBefore = runGit(["rev-parse", "HEAD"], { cwd: mainRoot }).stdout;

  const previewPath = resolvePreviewPath(mainRoot);
  assertPreviewWorktree(mainRoot, previewPath);
  assertCleanWorktree(previewPath, "Preview worktree");

  log("=== PR Preview switch ===");
  log(`main worktree : ${mainRoot} (${mainBranchBefore} @ ${mainHeadBefore.slice(0, 7)})`);
  log(`preview path  : ${previewPath}`);
  log(`PR            : #${prArg}`);
  log("");

  const pr = resolvePullRequestHead(mainRoot, prArg);
  logOk(
    `PR #${pr.number} HEAD = ${pr.sha.slice(0, 7)} (${pr.source}` +
      (pr.headRefName ? `, ${pr.headRefName}` : "") +
      `)`,
  );
  if (pr.title) log(`  title: ${pr.title}`);
  if (pr.url) log(`  url  : ${pr.url}`);

  // 最新を確実に取る（gh で SHA が分かっていても fetch）
  runGit(
    ["fetch", "origin", `pull/${pr.number}/head:refs/remotes/pull/${pr.number}/head`],
    {
      cwd: mainRoot,
      allowFail: true,
    },
  );
  runGit(["fetch", "origin", pr.sha], { cwd: mainRoot, allowFail: true });

  const head = checkoutPreviewAtSha(previewPath, pr.sha, { prNumber: pr.number });
  logOk(`Preview worktree を ${head.slice(0, 7)} に切り替えました`);

  const mainBranchAfter = runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: mainRoot,
  }).stdout;
  const mainHeadAfter = runGit(["rev-parse", "HEAD"], { cwd: mainRoot }).stdout;
  if (mainBranchAfter !== mainBranchBefore || mainHeadAfter !== mainHeadBefore) {
    throw new PreviewError(
      "安全停止: main worktree の HEAD/branch が変わってしまいました。手動確認してください。",
    );
  }
  logOk("main worktree は未変更です");

  reportPostCheckoutHints(mainRoot, previewPath, head);
  printPreviewNextSteps(previewPath);
});
