#!/usr/bin/env node
/**
 * Render API で One-Off Job を起動し、本番の DATABASE_URL でマイグレーションする。
 *
 * 事前（どちらか）:
 *   export RENDER_API_KEY="rnd_..."  （Render → Account → API Keys）
 *   または .env.migrate に RENDER_API_KEY= を書く（Git にコミットしない）
 *
 * 実行: npm run render:one-off-migrate
 *       npm run render:one-off-migrate -- pos-receipt-ciara
 */
import "./load-env-files.mjs";

const API = "https://api.render.com/v1";
const apiKey = process.env.RENDER_API_KEY?.trim();
const serviceFilter = process.argv[2]?.trim();

if (!apiKey) {
  console.error("ERROR: RENDER_API_KEY が未設定です。");
  console.error("Render ダッシュボード → Account Settings → API Keys で作成し、");
  console.error('  export RENDER_API_KEY="rnd_..."');
  process.exit(1);
}

const TARGET_NAMES = serviceFilter
  ? [serviceFilter]
  : ["pos-receipt", "pos-receipt-ciara"];

// 失敗記録の修復 + deploy（render-migrate.mjs と同じ。常に exit 0）
const START_COMMAND =
  "bash -lc 'cd /opt/render/project/src && npm run render:migrate'";

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
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
      `${options.method ?? "GET"} ${path} → ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
    );
  }
  return body;
}

async function listAllServices() {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 20; i++) {
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

async function createJob(serviceId, serviceName) {
  const body = await api(`/services/${serviceId}/jobs`, {
    method: "POST",
    body: JSON.stringify({ startCommand: START_COMMAND }),
  });
  const job = body?.job ?? body;
  console.log(
    `[ok] ${serviceName}: job ${job?.id ?? "(id unknown)"} — Render Logs で migrate の出力を確認してください`,
  );
}

async function main() {
  console.log("==> Render サービス一覧を取得");
  const services = await listAllServices();
  const matched = services.filter((s) => TARGET_NAMES.includes(s.name));

  if (matched.length === 0) {
    console.error(
      `ERROR: 対象サービスが見つかりません: ${TARGET_NAMES.join(", ")}`,
    );
    console.error(
      "利用可能な名前:",
      services.map((s) => s.name).join(", ") || "(なし)",
    );
    process.exit(1);
  }

  for (const svc of matched) {
    console.log(`==> One-Off Job 作成: ${svc.name} (${svc.id})`);
    await createJob(svc.id, svc.name);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
