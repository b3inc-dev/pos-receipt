/**
 * 管理画面左サイドバー用ナビゲーション。
 * polaris.js の s-app-nav / s-link はカスタム要素のため、
 * スクリプト読み込み完了後に DOM で直接構築する。
 */
import { useEffect, useRef } from "react";

const NAV_TAG = "s-app-nav";
const LINK_TAG = "s-link";

type NavItem = { href: string; label: string; rel?: string };

export function AppNav({ items, search }: { items: NavItem[]; search: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof document === "undefined") return;

    const mount = () => {
      if (!customElements.get(NAV_TAG)) return;
      container.innerHTML = "";
      const nav = document.createElement(NAV_TAG);
      for (const { href, label, rel } of items) {
        const link = document.createElement(LINK_TAG);
        link.setAttribute("href", href + search);
        if (rel) link.setAttribute("rel", rel);
        link.textContent = label;
        nav.appendChild(link);
      }
      container.appendChild(nav);
    };

    if (customElements.get(NAV_TAG)) {
      mount();
      return;
    }
    customElements.whenDefined(NAV_TAG).then(mount);
    const t = setTimeout(mount, 3000);
    return () => clearTimeout(t);
  }, [items, search]);

  return <div ref={containerRef} style={{ display: "contents" }} />;
}
