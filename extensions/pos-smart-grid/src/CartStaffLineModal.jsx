import { render } from "preact";
import { useState } from "preact/hooks";
import { runCartStaffAction } from "../../common/cartStaffAssignment.js";
import { CartStaffPanel, cartStaffErrorText, useCartStaffSnapshot } from "./CartStaffPanel.jsx";

export default async () => {
  render(<CartStaffLineModal />, document.body);
};

function CartStaffLineModal() {
  const snapshot = useCartStaffSnapshot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  let selectedUuid = "";
  try {
    selectedUuid = shopify?.cartLineItem?.uuid ?? "";
  } catch {
    selectedUuid = "";
  }
  const lines = selectedUuid
    ? snapshot.lines.filter((line) => line.uuid === selectedUuid)
    : [];

  const onAction = async (action) => {
    setBusy(true);
    setError("");
    try {
      const result = await runCartStaffAction(
        snapshot.lines,
        action,
        snapshot.roster,
        shopify.cart,
      );
      if (!result.ok) setError(cartStaffErrorText(result.code));
    } catch {
      setError(cartStaffErrorText("apply_failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CartStaffPanel
      lines={lines}
      roster={snapshot.roster}
      pinnedStaffId={snapshot.pinnedStaffId}
      editable={snapshot.editable}
      busy={busy}
      error={error || (selectedUuid ? "" : "明細を特定できませんでした。")}
      scope="line"
      onAction={onAction}
    />
  );
}
