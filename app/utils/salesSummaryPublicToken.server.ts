/**
 * ブラウザ公開用売上サマリーリンクのトークン（平文は DB に保存しない）
 */
import { createHash, randomBytes } from "node:crypto";

const PREFIX = "prs_";

/** 推測困難なトークン（先頭に接頭辞を付けて運用で識別しやすくする） */
export function generateSalesSummaryPublicToken(): string {
  return PREFIX + randomBytes(32).toString("hex");
}

export function hashSalesSummaryPublicToken(plain: string): string {
  return createHash("sha256").update(plain, "utf8").digest("hex");
}
