import { useEffect, useRef } from "react";
import { Button } from "@shopify/polaris";
import { useFetcher } from "react-router";
import { SettingsSaveDock } from "./SettingsSaveDock";

type Result = { ok: boolean; error?: string };

export function BudgetSaveDock({ field, targetId, date, amount, onSaved }: {
  field: "locationId" | "channelId";
  targetId: string;
  date: string;
  amount: string;
  onSaved: () => void;
}) {
  const save = useFetcher<Result>();
  const pending = useRef<{ targetId: string; date: string; amount: string; previous?: Result } | null>(null);
  useEffect(() => {
    const sent = pending.current;
    if (!sent || save.state !== "idle" || !save.data || save.data === sent.previous) return;
    pending.current = null;
    if (save.data.ok && targetId === sent.targetId && date === sent.date && amount === sent.amount) onSaved();
  }, [save.state, save.data, targetId, date, amount, onSaved]);

  if (!date && !amount) return null;
  const ready = Boolean(targetId && date.trim() && amount.trim()) && Number.isFinite(Number(amount));
  const submit = () => {
    if (!ready || pending.current || save.state !== "idle") return;
    pending.current = { targetId, date, amount, previous: save.data };
    save.submit({ intent: "upsert", [field]: targetId, targetDate: date, amount }, { method: "post" });
  };
  return (
    <SettingsSaveDock>
      {save.state === "idle" && save.data?.error && <span role="alert">{save.data.error}</span>}
      <Button variant="primary" disabled={!ready || save.state !== "idle"} loading={save.state !== "idle"} onClick={submit}>
        予算を保存
      </Button>
    </SettingsSaveDock>
  );
}
