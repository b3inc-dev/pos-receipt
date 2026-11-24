/**
 * Polaris React を使うページ用のラッパー。
 * 他アプリ（POS Stock 等）と同様、AppProvider 直下には PolarisAppProvider を置かず、
 * 各ページ内でのみラップする構成にする。
 */
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import jaTranslations from "@shopify/polaris/locales/ja.json";

export function PolarisPageWrapper({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <PolarisAppProvider i18n={jaTranslations}>
      <div style={wide ? {maxWidth:1200,margin:"0 auto"} : undefined}>{children}</div>
    </PolarisAppProvider>
  );
}
