import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { buildCartStaffRecord, overlayFromDraft, reconcileStaffLine, runCartStaffAction } from "../../common/cartStaffAssignment.js";
import { getCartStaffDraft, getPosStaff, saveCartStaffDraft, savePosStaff } from "../../common/orderPickerApi.js";
import { CartStaffPanel, cartStaffErrorText, useCartStaffSnapshot } from "./CartStaffPanel.jsx";
import { OrderDayListScreen } from "./OrderDayListScreen.jsx";
import { OrderStaffCorrection } from "./OrderStaffCorrection.jsx";

export default async () => {
  render(<CartStaffModal />, document.body);
};

const DRAFT_KEY_STORAGE = "pos_cart_staff_draft_key";
const DRAFT_LINES_STORAGE = "pos_cart_staff_draft_lines";

function draftKey() {
  try {
    const existing = sessionStorage.getItem(DRAFT_KEY_STORAGE);
    if (existing) return existing;
    const created = globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now()}`;
    sessionStorage.setItem(DRAFT_KEY_STORAGE, created);
    return created;
  } catch {
    return `draft-${Date.now()}`;
  }
}

function CartStaffModal() {
  const [appStaff, setAppStaff] = useState([]);
  const [overlay, setOverlay] = useState({});
  const snapshot = useCartStaffSnapshot(appStaff);
  const displayLines = snapshot.lines.map((line) => reconcileStaffLine(line, overlay[line.uuid]));
  const [step, setStep] = useState("cart");
  const [orderId, setOrderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getPosStaff()
      .then((result) => {
        if (Array.isArray(result?.staff)) setAppStaff(result.staff);
      })
      .catch(() => {});
  }, []);

  const cartIdentity = snapshot.lines.map((line) => `${line.uuid}:${line.quantity}:${line.variantId ?? ""}`).join("|");
  useEffect(() => {
    if (snapshot.lines.length === 0) return undefined;
    let cancelled = false;
    const restore = async () => {
      let lines = null;
      try {
        const raw = sessionStorage.getItem(DRAFT_LINES_STORAGE);
        if (raw) lines = JSON.parse(raw);
      } catch {
        lines = null;
      }
      try {
        const key = sessionStorage.getItem(DRAFT_KEY_STORAGE);
        if (key) {
          const remote = await getCartStaffDraft(key);
          if (Array.isArray(remote?.lines) && remote.lines.length > 0) lines = remote.lines;
        }
      } catch {
        // 端末に残した担当順を使う。
      }
      if (cancelled || !Array.isArray(lines)) return;
      const incoming = overlayFromDraft(snapshot.lines, lines);
      setOverlay((prev) => ({ ...incoming, ...prev }));
    };
    restore();
    return () => {
      cancelled = true;
    };
  }, [cartIdentity]);

  const onRegisterStaff = async (label) => {
    setBusy(true);
    setError("");
    try {
      const result = await savePosStaff(label);
      if (result?.staff?.key) {
        setAppStaff((prev) => prev.some((item) => item.key === result.staff.key) ? prev : [...prev, result.staff]);
      }
    } catch {
      setError("担当を追加できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const onAction = async (action) => {
    setBusy(true);
    setError("");
    try {
      const result = await runCartStaffAction(
        displayLines,
        action,
        snapshot.roster,
        shopify.cart,
      );
      if (!result.ok) {
        setError(cartStaffErrorText(result.code));
        return;
      }
      const nextLines = result.state?.lines ?? displayLines;
      setOverlay((prev) => {
        const next = { ...prev };
        const seen = new Set(snapshot.lines.map((line) => line.uuid));
        for (const line of nextLines) {
          if (line?.uuid) next[line.uuid] = line;
        }
        for (const uuid of Object.keys(next)) {
          if (!seen.has(uuid)) delete next[uuid];
        }
        return next;
      });
      const record = buildCartStaffRecord(nextLines);
      try {
        sessionStorage.setItem(DRAFT_LINES_STORAGE, JSON.stringify(record.lines));
      } catch {
        // 端末に残せなくても、保存APIへは送る。
      }
      try {
        await saveCartStaffDraft(draftKey(), record.lines);
      } catch {
        setError("担当順は画面に残しています。保存先への記録は失敗しました。");
      }
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
      lines={displayLines}
      roster={snapshot.roster}
      pinnedStaffId={snapshot.pinnedStaffId}
      editable={snapshot.editable}
      busy={busy}
      error={error}
      onAction={onAction}
      onOpenHistory={() => setStep("history")}
      onRegisterStaff={onRegisterStaff}
    />
  );
}
