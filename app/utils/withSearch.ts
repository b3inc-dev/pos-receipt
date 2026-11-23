/**
 * 埋め込みアプリの画面の移り先に、今の画面の検索パラメータ（shop・host など）を付ける。
 * extra は上書き・追加する値。
 */
export function withSearch(path: string, search: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams(search);
  if (extra) for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}
