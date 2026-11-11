import { render } from "preact";
import { useState } from "preact/hooks";
import { runCartStaffAction } from "../../common/cartStaffAssignment.js";
import { CartStaffPanel, cartStaffErrorText, useCartStaffSnapshot } from "./CartStaffPanel.jsx";

export default async () => {
  render(<CartStaffModal />, document.body);
};

function CartStaffModal() {
  const snapshot = useCartStaffSnapshot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
      lines={snapshot.lines}
      roster={snapshot.roster}
      pinnedStaffId={snapshot.pinnedStaffId}
      editable={snapshot.editable}
      busy={busy}
      error={error}
      onAction={onAction}
    />
  );
}
