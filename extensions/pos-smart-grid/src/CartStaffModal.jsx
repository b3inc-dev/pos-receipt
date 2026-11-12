import { render } from "preact";
import { useState } from "preact/hooks";
import { runCartStaffAction } from "../../common/cartStaffAssignment.js";
import { CartStaffPanel, cartStaffErrorText, useCartStaffSnapshot } from "./CartStaffPanel.jsx";
import { OrderDayListScreen } from "./OrderDayListScreen.jsx";
import { OrderStaffCorrection } from "./OrderStaffCorrection.jsx";

export default async () => {
  render(<CartStaffModal />, document.body);
};

function CartStaffModal() {
  const snapshot = useCartStaffSnapshot();
  const [step, setStep] = useState("cart");
  const [orderId, setOrderId] = useState("");
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

  if (step === "history") {
    return (
      <OrderDayListScreen
        pageHeading="確定済み取引"
        badgeMode="receipt"
        onSelectOrderId={(id) => {
          setOrderId(id);
          setStep("order");
        }}
        headerTrailing={<s-button onClick={() => setStep("cart")}>カートへ戻る</s-button>}
      />
    );
  }

  if (step === "order") {
    return <OrderStaffCorrection orderId={orderId} onBack={() => setStep("history")} />;
  }

  return (
    <CartStaffPanel
      lines={snapshot.lines}
      roster={snapshot.roster}
      pinnedStaffId={snapshot.pinnedStaffId}
      editable={snapshot.editable}
      busy={busy}
      error={error}
      onAction={onAction}
      onOpenHistory={() => setStep("history")}
    />
  );
}
