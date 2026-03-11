// App Bridge ナビゲーション用 Web コンポーネント（管理画面左サイドバーにメニューを表示）
declare global {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
      "s-link": React.DetailedHTMLProps<
        React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; rel?: string },
        HTMLAnchorElement
      >;
    }
  }
}

export {};
