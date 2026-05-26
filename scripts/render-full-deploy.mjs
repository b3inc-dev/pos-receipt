#!/usr/bin/env node
/**
 * Render: 両 Web サービスのコマンド設定を直す → マイグレーション One-Off → デプロイ
 *
 * 事前: .env.migrate に RENDER_API_KEY=rnd_... を入れる（Git にコミットしない）
 * 実行: npm run render:full-deploy
 */
import "./load-env-files.mjs";

const API = "https://api.render.com/v1";
const apiKey = process.env.RENDER_API_KEY?.trim();

const TARGETS = ["pos-receipt", "pos-receipt-ciara"];
const BUILD_COMMAND = "npm install && npx prisma generate && npm run build";
const PRE_DEPLOY = "npm run render:migrate";
const START_COMMAND = "npm run start";
const MIGRATE_JOB = "bash -lc 'cd /opt/render/project/src && npm run render:migrate'";

if (!apiKey) {
  console.error(
    [
      "ERROR: RENDER_API_KEY が未設定です。",
      "",
      "  cp .env.migrate.example .env.migrate",
      "  → RENDER_API_KEY= に Render の API キーを貼る",
      "  → npm run render:full-deploy",
    ].join("\n"),
  );
  process.exit(1);
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${path} → ${res.status}: ${
        typeof body === "string" ? body : JSON.stringify(body)
      }`,
    );
  }
  return body;
}

async function listServices() {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 30; i++) {
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = await api(`/services${q}`);
    const items = Array.isArray(page) ? page : (page?.items ?? []);
    for (const item of items) {
      const svc = item?.service ?? item;
      if (svc?.id && svc?.name) out.push(svc);
    }
    cursor = page?.cursor ?? page?.next ?? null;
    if (!cursor || items.length === 0) break;
  }
  return out;
}

async function patchServiceCommands(service) {
  const body = {
    serviceDetails: {
      env: "node",
      buildCommand: BUILD_COMMAND,
      preDeployCommand: PRE_DEPLOY,
      startCommand: START_COMMAND,
    },
  };
  console.log(`==> 設定更新: ${service.name} (${service.id})`);
  await api(`/services/${service.id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function createMigrateJob(service) {
  console.log(`==> マイグレーション Job: ${service.name}`);
  await api(`/services/${service.id}/jobs`, {
    method: "POST",
    body: JSON.stringify({ startCommand: MIGRATE_JOB }),
  });
}

async function triggerDeploy(service) {
  console.log(`==> デプロイ開始: ${service.name}`);
  await api(`/services/${service.id}/deploys`, {
    method: "POST",
    body: JSON.stringify({ clearCache: "do_not_clear" }),
  });
}

async function main() {
  const all = await listServices();
  const matched = all.filter((s) => TARGETS.includes(s.name));
  const missing = TARGETS.filter((n) => !matched.some((s) => s.name === n));

  if (missing.length) {
    console.error("見つからないサービス:", missing.join(", "));
    console.error("存在する名前:", all.map((s) => s.name).join(", ") || "(なし)");
    process.exit(1);
  }

  for (const svc of matched) {
    await patchServiceCommands(svc);
    await createMigrateJob(svc);
  }

  console.log("==> マイグレーション Job の完了を Render Logs で確認してからデプロイします（15秒待機）");
  await new Promise((r) => setTimeout(r, 15000));

  for (const svc of matched) {
    await triggerDeploy(svc);
  }

  console.log("");
  console.log("完了。Render ダッシュボード → 各サービス → Logs で確認してください。");
  console.log("  pos-receipt:         https://pos-receipt.onrender.com/api/health/db");
  console.log("  pos-receipt-ciara:   https://pos-receipt-ciara.onrender.com/api/health/db");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
