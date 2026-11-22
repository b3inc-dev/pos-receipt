/**
 * システムグループ内の「高度な設定」折りたたみ。
 * diagnostics / backfill は日常タブから外し、ここから遷移する。
 */
import { useState } from "react";
import { useLocation } from "react-router";
import { useGuardedNavigate } from "./admin-ui";
import { BlockStack, Box, Button, Card, Collapsible, InlineStack, Text } from "@shopify/polaris";

const ADVANCED_LINKS = [
  { path: "/app/diagnostics", label: "システム診断", devStoreOnly: true },
  { path: "/app/backfill", label: "過去データ取込", devStoreOnly: false },
] as const;

/**
 * showDiagnostics: 開発ストアのときだけ true（T さんの決定 2026-11-22。システム診断は客先の店に出さない）。
 */
export function SystemAdvancedNav({ showDiagnostics = false }: { showDiagnostics?: boolean }) {
  const location = useLocation();
  const navigate = useGuardedNavigate();
  const search = location.search || "";
  const links = ADVANCED_LINKS.filter((l) => !l.devStoreOnly || showDiagnostics);
  const onAdvancedPage = links.some((l) => l.path === location.pathname);
  const [open, setOpen] = useState(onAdvancedPage);

  return (
    <Box paddingBlockStart="300" paddingBlockEnd="200">
      <Card>
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingSm">
              高度な設定
            </Text>
            <Button
              variant="plain"
              disclosure={open ? "up" : "down"}
              onClick={() => setOpen((v) => !v)}
              ariaExpanded={open}
              ariaControls="system-advanced-settings"
            >
              {open ? "閉じる" : "開く"}
            </Button>
          </InlineStack>
          <Text as="p" tone="subdued" variant="bodySm">
            {showDiagnostics ? "診断・過去データ取込など、日常運用以外の操作です。" : "過去データ取込など、日常運用以外の操作です。"}
          </Text>
          <Collapsible
            open={open}
            id="system-advanced-settings"
            transition={{ duration: "150ms", timingFunction: "ease" }}
          >
            <Box paddingBlockStart="200">
              <InlineStack gap="300" wrap>
                {links.map((link) => {
                  const active = location.pathname === link.path;
                  return (
                    <Button
                      key={link.path}
                      variant={active ? "primary" : "secondary"}
                      onClick={() => navigate(link.path + search)}
                    >
                      {link.label}
                    </Button>
                  );
                })}
              </InlineStack>
            </Box>
          </Collapsible>
        </BlockStack>
      </Card>
    </Box>
  );
}
