/**
 * PR Preview worktree 用の共通処理。
 * main 作業ディレクトリを切り替えず、sibling preview worktree だけを操作する。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const DEFAULT_PREVIEW_RELATIVE_PATH = "../ciara-system-preview";
export const PREVIEW_BRANCH = "preview/current";
export const PREVIEW_PORT = 3001;
export const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}`;
export const LOCAL_PATH_FILE = ".preview-worktree.path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(__dirname, "..");

export class PreviewError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = "PreviewError";
    this.exitCode = exitCode;
  }
}

export function log(msg = "") {
  console.log(msg);
}

export function logWarn(msg) {
  console.warn(`⚠️  ${msg}`);
}

export function logOk(msg) {
  console.log(`✓ ${msg}`);
}

export function runGit(args, { cwd, stdio = "pipe", allowFail = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 && !allowFail) {
    const err = (result.stderr || result.stdout || "").trim();
    throw new PreviewError(
      `git ${args.join(" ")} に失敗しました${err ? `: ${err}` : ""}`,
    );
  }
  return {
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

export function gitOutput(args, cwd) {
  return runGit(args, { cwd }).stdout;
}

export function findMainRepoRoot(startDir = process.cwd()) {
  const root = gitOutput(["rev-parse", "--show-toplevel"], startDir);
  return resolve(root);
}

export function resolvePreviewPath(mainRoot, { env = process.env } = {}) {
  const fromEnv = env.PREVIEW_WORKTREE_PATH?.trim();
  if (fromEnv) {
    return isAbsolute(fromEnv) ? fromEnv : resolve(mainRoot, fromEnv);
  }

  const localFile = join(mainRoot, LOCAL_PATH_FILE);
  if (existsSync(localFile)) {
    const fromFile = readFileSync(localFile, "utf8").trim();
    if (fromFile) {
      return isAbsolute(fromFile) ? fromFile : resolve(mainRoot, fromFile);
    }
  }

  return resolve(mainRoot, DEFAULT_PREVIEW_RELATIVE_PATH);
}

export function isGitWorktree(dir) {
  if (!existsSync(dir)) return false;
  const r = runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd: dir,
    allowFail: true,
  });
  return r.status === 0 && r.stdout === "true";
}

export function sameGitCommonDir(a, b) {
  const commonA = gitOutput(["rev-parse", "--git-common-dir"], a);
  const commonB = gitOutput(["rev-parse", "--git-common-dir"], b);
  return resolve(a, commonA) === resolve(b, commonB);
}

export function assertPreviewWorktree(mainRoot, previewPath) {
  if (!existsSync(previewPath)) {
    throw new PreviewError(
      `Preview worktree がありません: ${previewPath}\n先に main 側で npm run preview:setup を実行してください。`,
    );
  }
  if (!isGitWorktree(previewPath)) {
    throw new PreviewError(
      `パスは存在しますが Git worktree ではありません（破棄せず停止）: ${previewPath}`,
    );
  }
  if (!sameGitCommonDir(mainRoot, previewPath)) {
    throw new PreviewError(
      `別リポジトリのディレクトリです（破棄せず停止）: ${previewPath}`,
    );
  }
  const previewRoot = gitOutput(["rev-parse", "--show-toplevel"], previewPath);
  if (resolve(previewRoot) === resolve(mainRoot)) {
    throw new PreviewError(
      "Preview パスが main worktree と同じです。PREVIEW_WORKTREE_PATH を確認してください。",
    );
  }
}

export function isWorktreeDirty(dir) {
  const status = gitOutput(["status", "--porcelain"], dir);
  return status.length > 0;
}

export function assertCleanWorktree(dir, label) {
  if (isWorktreeDirty(dir)) {
    const status = gitOutput(["status", "--porcelain"], dir);
    throw new PreviewError(
      `${label} に未コミット変更があります。破棄せず安全停止します。\n` +
        `path: ${dir}\n${status}\n` +
        `変更を commit / 別途退避してから再実行してください（reset --hard / clean -fd は使いません）。`,
    );
  }
}

export function listWorktrees(mainRoot) {
  const out = gitOutput(["worktree", "list", "--porcelain"], mainRoot);
  const items = [];
  let current = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) items.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length);
    } else if (line === "detached" && current) {
      current.detached = true;
    } else if (line === "" && current) {
      items.push(current);
      current = null;
    }
  }
  if (current) items.push(current);
  return items;
}

export function ensurePreviewWorktree(mainRoot, previewPath) {
  if (existsSync(previewPath)) {
    assertPreviewWorktree(mainRoot, previewPath);
    assertCleanWorktree(previewPath, "Preview worktree");
    logOk(`既存の Preview worktree を再利用します: ${previewPath}`);
    return { created: false, path: previewPath };
  }

  const parent = dirname(previewPath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }

  // main の HEAD を起点に専用 branch で worktree を追加（本体 branch は切り替えない）
  const startSha = gitOutput(["rev-parse", "HEAD"], mainRoot);
  const branchExists = runGit(["show-ref", "--verify", "--quiet", `refs/heads/${PREVIEW_BRANCH}`], {
    cwd: mainRoot,
    allowFail: true,
  }).status === 0;

  if (branchExists) {
    // 既存 branch があるが worktree が無い場合: その branch で追加
    const inUse = listWorktrees(mainRoot).some(
      (w) => w.branch === `refs/heads/${PREVIEW_BRANCH}`,
    );
    if (inUse) {
      throw new PreviewError(
        `${PREVIEW_BRANCH} は別 worktree で使用中です。PREVIEW_WORKTREE_PATH を確認してください。`,
      );
    }
    runGit(["worktree", "add", previewPath, PREVIEW_BRANCH], {
      cwd: mainRoot,
      stdio: "inherit",
    });
  } else {
    runGit(["worktree", "add", "-b", PREVIEW_BRANCH, previewPath, startSha], {
      cwd: mainRoot,
      stdio: "inherit",
    });
  }

  logOk(`Preview worktree を作成しました: ${previewPath}`);
  log(`  branch: ${PREVIEW_BRANCH}`);
  return { created: true, path: previewPath };
}

/**
 * PR の最新 HEAD SHA を解決する。
 * 1) gh pr view
 * 2) fallback: git fetch refs/pull/<n>/head
 */
export function resolvePullRequestHead(mainRoot, prNumber, { env = process.env } = {}) {
  const n = Number(prNumber);
  if (!Number.isInteger(n) || n <= 0) {
    throw new PreviewError(`PR番号が不正です: ${prNumber}`);
  }

  const remoteUrl =
    env.PREVIEW_GITHUB_REPO ||
    gitOutput(["config", "--get", "remote.origin.url"], mainRoot).replace(
      /x-access-token:[^@]+@/,
      "github.com/",
    );
  const repoMatch = String(remoteUrl).match(/github\.com[:/](.+?)(?:\.git)?$/);
  const repo = env.PREVIEW_GITHUB_REPO || (repoMatch ? repoMatch[1] : null);

  // gh 優先（テストやオフラインでは PREVIEW_SKIP_GH=1 でスキップ可）
  let ghErr = "";
  if (env.PREVIEW_SKIP_GH !== "1") {
    const gh = spawnSync(
      "gh",
      [
        "pr",
        "view",
        String(n),
        ...(repo ? ["--repo", repo] : []),
        "--json",
        "number,state,headRefOid,headRefName,url,title",
      ],
      { encoding: "utf8" },
    );
    if (gh.status === 0 && gh.stdout?.trim()) {
      try {
        const data = JSON.parse(gh.stdout);
        if (!data.headRefOid) {
          throw new PreviewError(`PR #${n} の HEAD を取得できませんでした。`);
        }
        return {
          number: data.number,
          sha: data.headRefOid,
          headRefName: data.headRefName,
          url: data.url,
          title: data.title,
          state: data.state,
          source: "gh",
        };
      } catch (e) {
        if (e instanceof PreviewError) throw e;
        // fall through to git refs
      }
    }

    ghErr = (gh.stderr || gh.stdout || "").trim();
    if (
      /could not find|not found|no pull requests found|HTTP 404|Could not resolve to a PullRequest/i.test(
        ghErr,
      )
    ) {
      throw new PreviewError(
        `PR #${n} は存在しません（gh）。\n${ghErr || "not found"}`,
      );
    }
  }

  // fallback: refs/pull/<n>/head
  const ref = `refs/pull/${n}/head`;
  const fetch = runGit(["fetch", "origin", `+${ref}:refs/remotes/pull/${n}/head`], {
    cwd: mainRoot,
    allowFail: true,
  });
  if (fetch.status !== 0) {
    const detail = fetch.stderr || fetch.stdout || ghErr || "fetch failed";
    if (/couldn't find remote ref|does not exist|unable to find|not found/i.test(detail)) {
      throw new PreviewError(`PR #${n} は存在しません（refs/pull/${n}/head）。\n${detail}`);
    }
    throw new PreviewError(
      `PR #${n} の取得に失敗しました。gh も refs/pull も使えませんでした。\ngh: ${ghErr || "(none)"}\ngit: ${detail}`,
    );
  }
  const sha = gitOutput(["rev-parse", `refs/remotes/pull/${n}/head`], mainRoot);
  return {
    number: n,
    sha,
    headRefName: `pull/${n}/head`,
    url: repo ? `https://github.com/${repo}/pull/${n}` : null,
    title: null,
    state: null,
    source: "refs/pull",
  };
}

export function previewStatePath(previewPath) {
  // worktree 内にファイルを置くと未追跡で dirty になるため、git common dir に保存する
  const common = resolve(
    previewPath,
    gitOutput(["rev-parse", "--git-common-dir"], previewPath),
  );
  return join(common, "preview-pr-state");
}

export function writePreviewState(previewPath, prNumber, sha) {
  writeFileSync(
    previewStatePath(previewPath),
    `${String(prNumber)}\n${sha}\n`,
    "utf8",
  );
}

export function readPreviewState(previewPath) {
  const p = previewStatePath(previewPath);
  if (!existsSync(p)) return null;
  const [prNumber, sha] = readFileSync(p, "utf8").trim().split("\n");
  return { prNumber, sha };
}

export function checkoutPreviewAtSha(previewPath, sha, { prNumber } = {}) {
  assertCleanWorktree(previewPath, "Preview worktree");
  // reset --hard は使わない。clean なときだけ branch を目的 SHA へ付け替える。
  runGit(["fetch", "origin", sha], { cwd: previewPath, allowFail: true });
  runGit(["switch", "-C", PREVIEW_BRANCH, sha], { cwd: previewPath, stdio: "inherit" });
  const head = gitOutput(["rev-parse", "HEAD"], previewPath);
  if (head !== sha) {
    throw new PreviewError(
      `Preview HEAD が期待と一致しません (expected ${sha}, got ${head})`,
    );
  }
  if (prNumber != null) {
    writePreviewState(previewPath, prNumber, sha);
  }
  return head;
}

export function filesDiffer(mainRoot, leftSha, rightSha, paths) {
  const changed = [];
  for (const p of paths) {
    const a = runGit(["show", `${leftSha}:${p}`], { cwd: mainRoot, allowFail: true });
    const b = runGit(["show", `${rightSha}:${p}`], { cwd: mainRoot, allowFail: true });
    if (a.status !== 0 && b.status !== 0) continue;
    if (a.status !== b.status || a.stdout !== b.stdout) {
      changed.push(p);
    }
  }
  return changed;
}

export function detectDependencyDrift(mainRoot, mainSha, previewSha) {
  return filesDiffer(mainRoot, mainSha, previewSha, [
    "package.json",
    "package-lock.json",
  ]);
}

export function detectPrismaDrift(mainRoot, mainSha, previewSha) {
  const diff = runGit(
    [
      "diff",
      "--name-only",
      mainSha,
      previewSha,
      "--",
      "prisma/schema.prisma",
      "prisma/migrations",
    ],
    { cwd: mainRoot, allowFail: true },
  );
  if (diff.status !== 0 || !diff.stdout) return [];
  return diff.stdout.split("\n").filter(Boolean);
}

export function reportPostCheckoutHints(mainRoot, previewPath, previewSha) {
  const mainSha = gitOutput(["rev-parse", "HEAD"], mainRoot);
  const depChanged = detectDependencyDrift(mainRoot, mainSha, previewSha);
  const prismaChanged = detectPrismaDrift(mainRoot, mainSha, previewSha);

  if (depChanged.length > 0) {
    logWarn(
      `main と比べて依存ファイルが変わっています: ${depChanged.join(", ")}`,
    );
    logWarn(
      "Preview worktree で `npm ci` が必要かもしれません。既存 node_modules を壊さないよう自動実行はしません。",
    );
    log(`  cd ${previewPath} && npm ci`);
  } else {
    logOk("package.json / package-lock.json は main と差分なし（npm ci は任意）");
  }

  if (prismaChanged.length > 0) {
    logWarn(
      `Prisma 関連の変更があります（警告のみ。db push / migrate apply / 本番DB操作は自動実行しません）:`,
    );
    for (const f of prismaChanged) log(`  - ${f}`);
  }

  return { depChanged, prismaChanged, mainSha, previewSha };
}

export function printPreviewNextSteps(previewPath) {
  log("");
  log("次の手順:");
  log(`  cd ${previewPath}`);
  log("  npm run preview:dev");
  log(`  ブラウザ: ${PREVIEW_URL}`);
  log("");
  log("確認後（問題なければ）:");
  log('  「プレビュー確認済み。問題ないので本番反映まで進めて。」');
  log("  → 既存の production release workflow（DEV_FIRST_THEN_DEPLOY）へ進む");
}

export function withPreviewErrors(fn) {
  try {
    fn();
  } catch (e) {
    if (e instanceof PreviewError) {
      console.error(`\nエラー: ${e.message}\n`);
      process.exit(e.exitCode);
    }
    throw e;
  }
}
