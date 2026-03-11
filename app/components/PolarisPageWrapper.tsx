/**
 * Polaris React を使うページ用のラッパー。
 * 他アプリ（POS Stock 等）と同様、AppProvider 直下には PolarisAppProvider を置かず、
 * 各ページ内でのみラップする構成にする。
 */
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";

export function PolarisPageWrapper({ children }: { children: React.ReactNode }) {
  return (
    <PolarisAppProvider i18n={enTranslations}>
      {children}
    </PolarisAppProvider>
  );
}
