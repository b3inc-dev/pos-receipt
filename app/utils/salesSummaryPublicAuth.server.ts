/**
 * 公開売上サマリー: パスワード検証（scrypt）と Cookie 署名（HMAC）
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_KEYLEN = 64;
const SEP = ":";
const COOKIE_NAME = "prs_summary_auth";
const COOKIE_MAX_AGE_SEC = 7 * 24 * 3600;

export const PUBLIC_SUMMARY_AUTH_COOKIE = COOKIE_NAME;

export function hashPublicSummaryPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}${SEP}${hash}`;
}

export function verifyPublicSummaryPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored || !plain) return false;
  const idx = stored.indexOf(SEP);
  if (idx < 1) return false;
  const salt = stored.slice(0, idx);
  const expectedHex = stored.slice(idx + 1);
  let hash: Buffer;
  try {
    hash = scryptSync(plain, salt, SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  try {
    const exp = Buffer.from(expectedHex, "hex");
    return exp.length === hash.length && timingSafeEqual(exp, hash);
  } catch {
    return false;
  }
}

function cookieSigningSecret(): string {
  const s =
    (process.env.SHOPIFY_API_SECRET ?? "").trim() ||
    (process.env.SALES_SUMMARY_PUBLIC_COOKIE_SECRET ?? "").trim();
  return s;
}

export function hasPublicSummaryCookieSecret(): boolean {
  return Boolean(cookieSigningSecret());
}

/** 署名付き Cookie 値（Set-Cookie の value 部用に URL エンコード前提の文字列） */
export function signPublicSummaryAuthCookieValue(tokenHash: string): string {
  const secret = cookieSigningSecret();
  if (!secret) {
    throw new Error(
      "公開ページ用パスワードを使うには SHOPIFY_API_SECRET または SALES_SUMMARY_PUBLIC_COOKIE_SECRET を設定してください。",
    );
  }
  const exp = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE_SEC;
  const payload = `${tokenHash}.${exp}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sig}`;
}

export function verifyPublicSummaryAuthCookieValue(cookieValue: string, expectedTokenHash: string): boolean {
  const secret = cookieSigningSecret();
  if (!secret) return false;
  const dot = cookieValue.lastIndexOf(".");
  if (dot < 0) return false;
  const b64 = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  let payload: string;
  try {
    payload = Buffer.from(b64, "base64url").toString("utf8");
  } catch {
    return false;
  }
  const expectedSig = createHmac("sha256", secret).update(payload).digest("hex");
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expectedSig, "hex");
    if (a.length !== b.length) return false;
    if (!timingSafeEqual(a, b)) return false;
  } catch {
    return false;
  }
  const [th, expStr] = payload.split(".");
  if (th !== expectedTokenHash) return false;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  return true;
}

/** Cookie ヘッダー文字列から prs_summary_auth の値を取り出す */
export function getPublicSummaryAuthCookieFromHeader(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";").map((p) => p.trim());
  const prefix = `${COOKIE_NAME}=`;
  for (const p of parts) {
    if (p.startsWith(prefix)) {
      return decodeURIComponent(p.slice(prefix.length));
    }
  }
  return null;
}

export function isPublicSummaryPasswordVerified(
  cookieHeader: string | null,
  tokenHash: string,
): boolean {
  const raw = getPublicSummaryAuthCookieFromHeader(cookieHeader);
  if (!raw) return false;
  return verifyPublicSummaryAuthCookieValue(raw, tokenHash);
}

export function buildPublicSummaryAuthSetCookieHeader(tokenHash: string): string {
  const val = signPublicSummaryAuthCookieValue(tokenHash);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SEC}${secure}`;
}
