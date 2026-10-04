#!/usr/bin/env node
/**
 * PR Preview workflow の最小テスト（node:test）。
 * 一時 git リポジトリで setup / 再利用 / PR切替 / dirty / 欠番 / package検知 を検証する。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_SCRIPTS = SCRIPT_DIR;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    ...opts,
  });
  return r;
}

function git(cwd, args) {
  const r = run("git", args, { cwd });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return (r.stdout || "").trim();
}

let baseDir;
let bareDir;
let mainDir;
let previewDir;
let lib;

before(async () => {
  baseDir = mkdtempSync(join(tmpdir(), "preview-pr-test-"));
  bareDir = join(baseDir, "remote.git");
  mainDir = join(baseDir, "pos-receipt");
  previewDir = join(baseDir, "ciara-system-preview");

  run("git", ["init", "--bare", bareDir]);
  mkdirSync(mainDir);
  git(mainDir, ["init"]);
  git(mainDir, ["config", "user.email", "test@example.com"]);
  git(mainDir, ["config", "user.name", "test"]);
  git(mainDir, ["remote", "add", "origin", bareDir]);

  writeFileSync(join(mainDir, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2));
  writeFileSync(join(mainDir, "package-lock.json"), JSON.stringify({ name: "demo", lockfileVersion: 3 }, null, 2));
  mkdirSync(join(mainDir, "prisma"), { recursive: true });
  writeFileSync(join(mainDir, "prisma", "schema.prisma"), "generator client { provider = \"prisma-client-js\" }\n");
  mkdirSync(join(mainDir, "scripts"), { recursive: true });

  // copy preview scripts into fixture so npm-like invocation works
  for (const f of [
    "preview-lib.mjs",
    "preview-setup.mjs",
    "preview-pr.mjs",
    "preview-dev.mjs",
  ]) {
    writeFileSync(join(mainDir, "scripts", f), readFileSync(join(REPO_SCRIPTS, f)));
  }

  git(mainDir, ["add", "."]);
  git(mainDir, ["commit", "-m", "init"]);
  git(mainDir, ["branch", "-M", "main"]);
  git(mainDir, ["push", "-u", "origin", "main"]);

  // PR #27 branch with package.json change
  git(mainDir, ["checkout", "-b", "feature/pr-27"]);
  writeFileSync(
    join(mainDir, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.1", scripts: { x: "echo" } }, null, 2),
  );
  writeFileSync(join(mainDir, "feature.txt"), "pr27\n");
  git(mainDir, ["add", "."]);
  git(mainDir, ["commit", "-m", "pr27"]);
  git(mainDir, ["push", "origin", "feature/pr-27"]);
  const pr27Sha = git(mainDir, ["rev-parse", "HEAD"]);
  // simulate GitHub pull ref
  run("git", ["update-ref", `refs/pull/27/head`, pr27Sha], { cwd: bareDir });

  // PR #28 without package change (HEAD update later)
  git(mainDir, ["checkout", "main"]);
  git(mainDir, ["checkout", "-b", "feature/pr-28"]);
  writeFileSync(join(mainDir, "only.txt"), "v1\n");
  git(mainDir, ["add", "."]);
  git(mainDir, ["commit", "-m", "pr28-v1"]);
  git(mainDir, ["push", "origin", "feature/pr-28"]);
  let pr28Sha = git(mainDir, ["rev-parse", "HEAD"]);
  run("git", ["update-ref", `refs/pull/28/head`, pr28Sha], { cwd: bareDir });

  git(mainDir, ["checkout", "main"]);

  lib = await import(pathToFileURL(join(mainDir, "scripts", "preview-lib.mjs")).href);

  // Force preview path for all child processes
  process.env.PREVIEW_WORKTREE_PATH = previewDir;
});

after(() => {
  // テスト用一時ディレクトリのみ削除（repo 本体や本番は触らない）
  if (baseDir && existsSync(baseDir)) {
    // worktree 解除を試みてから削除
    run("git", ["worktree", "remove", "--force", previewDir], { cwd: mainDir });
    rmSync(baseDir, { recursive: true, force: true });
  }
});

function runSetup() {
  return run("node", ["scripts/preview-setup.mjs"], {
    cwd: mainDir,
    env: { ...process.env, PREVIEW_WORKTREE_PATH: previewDir },
  });
}

function runPreviewPr(n) {
  return run("node", ["scripts/preview-pr.mjs", String(n)], {
    cwd: mainDir,
    env: {
      ...process.env,
      PREVIEW_WORKTREE_PATH: previewDir,
      PREVIEW_SKIP_GH: "1",
      PATH: process.env.PATH,
    },
  });
}

test("preview:setup 初回作成", () => {
  const r = runSetup();
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /作成しました|setup 完了/);
  assert.ok(existsSync(previewDir));
  assert.equal(
    run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: previewDir }).stdout.trim(),
    "true",
  );
});

test("preview:setup 既存再利用（二重作成しない）", () => {
  const before = run("git", ["worktree", "list"], { cwd: mainDir }).stdout;
  const r = runSetup();
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /再利用/);
  const after = run("git", ["worktree", "list"], { cwd: mainDir }).stdout;
  const count = (s) => (s.match(/ciara-system-preview/g) || []).length;
  assert.equal(count(before), count(after));
});

test("preview:pr 正常系（#27）と package 変更検知", () => {
  const mainHeadBefore = git(mainDir, ["rev-parse", "HEAD"]);
  const mainBranchBefore = git(mainDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const r = runPreviewPr(27);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /PR #27/);
  assert.match(r.stdout, /依存ファイルが変わっています|npm ci/);
  const previewHead = git(previewDir, ["rev-parse", "HEAD"]);
  const expected = run("git", ["rev-parse", "refs/pull/27/head"], { cwd: bareDir }).stdout.trim();
  assert.equal(previewHead, expected);
  assert.equal(git(mainDir, ["rev-parse", "HEAD"]), mainHeadBefore);
  assert.equal(git(mainDir, ["rev-parse", "--abbrev-ref", "HEAD"]), mainBranchBefore);
});

test("存在しない PR は明確エラー", () => {
  const r = runPreviewPr(999999);
  assert.notEqual(r.status, 0);
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /存在しません|not found|couldn't find|failed/i);
});

test("dirty な preview は破棄せず安全停止", () => {
  writeFileSync(join(previewDir, "dirty.txt"), "nope\n");
  const r = runPreviewPr(27);
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}\n${r.stderr}`, /未コミット変更|安全停止/);
  assert.ok(existsSync(join(previewDir, "dirty.txt")), "dirty ファイルは残す");
  // テスト後は dirty ファイルだけ削除して clean に戻す（reset --hard / clean -fd は使わない）
  rmSync(join(previewDir, "dirty.txt"));
});

test("HEAD 更新後に再 fetch して最新へ", () => {
  // ensure clean preview on 28 first
  let r = runPreviewPr(28);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const first = git(previewDir, ["rev-parse", "HEAD"]);

  // update PR 28 head on remote
  git(mainDir, ["checkout", "feature/pr-28"]);
  writeFileSync(join(mainDir, "only.txt"), "v2\n");
  git(mainDir, ["add", "."]);
  git(mainDir, ["commit", "-m", "pr28-v2"]);
  git(mainDir, ["push", "origin", "feature/pr-28"]);
  const newSha = git(mainDir, ["rev-parse", "HEAD"]);
  run("git", ["update-ref", `refs/pull/28/head`, newSha], { cwd: bareDir });
  git(mainDir, ["checkout", "main"]);

  r = runPreviewPr(28);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const second = git(previewDir, ["rev-parse", "HEAD"]);
  assert.notEqual(first, second);
  assert.equal(second, newSha);
});

test("detectDependencyDrift / prisma 警告ヘルパ", () => {
  const mainSha = git(mainDir, ["rev-parse", "main"]);
  const pr27 = run("git", ["rev-parse", "refs/pull/27/head"], { cwd: bareDir }).stdout.trim();
  const dep = lib.detectDependencyDrift(mainDir, mainSha, pr27);
  assert.ok(dep.includes("package.json"));
  const prisma = lib.detectPrismaDrift(mainDir, mainSha, pr27);
  assert.ok(Array.isArray(prisma));
});

test("resolvePreviewPath 既定は ../ciara-system-preview", () => {
  const prev = process.env.PREVIEW_WORKTREE_PATH;
  delete process.env.PREVIEW_WORKTREE_PATH;
  const resolved = lib.resolvePreviewPath(mainDir, { env: {} });
  assert.equal(resolved, join(baseDir, "ciara-system-preview"));
  process.env.PREVIEW_WORKTREE_PATH = prev;
});
