/**
 * リクエストのログに出す URL から、ログに残したくない値（管理画面のトークンなど）を伏せる。
 * キーは残し、値だけ「-」にする（どのパラメータが付いていたかは分かるように）。
 */
const SECRET_KEYS = new Set(["id_token", "session", "hmac", "signature", "token", "code", "state", "password", "access_token"]);

export function redactLogUrl(url) {
  const s = String(url ?? "");
  const q = s.indexOf("?");
  if (q < 0) return s;
  const path = s.slice(0, q);
  const parts = s
    .slice(q + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const rawKey = eq < 0 ? pair : pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        /* そのまま */
      }
      return SECRET_KEYS.has(key.toLowerCase()) ? `${rawKey}=-` : pair;
    });
  return `${path}?${parts.join("&")}`;
}
