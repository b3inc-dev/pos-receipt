/**
 * システムグループ内の「高度な設定」折りたたみ。
 * diagnostics / backfill は日常タブから外し、ここから遷移する。
 */
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { BlockStack, Box, Button, Card, Collapsible, InlineStack, Text } from "@shopify/polaris";

const ADVANCED_LINKS = [
  { path: "/app/diagnostics", label: "システム診断" },
  { path: "/app/backfill", label: "過去データ取込" },
] as const;

export function SystemAdvancedNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const search = location.search || "";
  const onAdvancedPage = ADVANCED_LINKS.some((l) => l.path === location.pathname);
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
            診断・過去データ取込など、日常運用以外の操作です。
          </Text>
          <Collapsible
            open={open}
            id="system-advanced-settings"
            transition={{ duration: "150ms", timingFunction: "ease" }}
          >
            <Box paddingBlockStart="200">
              <InlineStack gap="300" wrap>
                {ADVANCED_LINKS.map((link) => {
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
