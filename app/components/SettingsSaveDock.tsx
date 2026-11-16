import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@shopify/polaris";
import { useActionData, useNavigation } from "react-router";

/** Keep the last control reachable even when the buttons wrap or text is enlarged. */
export function SettingsSaveDock({ children }: { children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const element = bar.current;
    if (!element) return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div aria-hidden="true" className="ReceiptDock-space" style={{ height }} />
      <div className="ReceiptDock" ref={bar}>{children}</div>
    </>
  );
}

export function SettingsSave({ onSave, label = "保存", children }: {
  onSave: () => void;
  label?: string;
  children?: ReactNode;
}) {
  const navigation = useNavigation();
  return (
    <SettingsSaveDock>
      {children}
      <Button variant="primary" onClick={onSave} disabled={navigation.state !== "idle"}>{label}</Button>
    </SettingsSaveDock>
  );
}

export function useSavedFeedback() {
  const result = useActionData<{ ok?: boolean }>();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setSaved(result?.ok === true);
    if (result?.ok) {
      const timer = setTimeout(() => setSaved(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [result]);
  return saved;
}
