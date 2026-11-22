/**
 * React の状態で入力を持つ Polaris の設定画面に、Shopify の保存の帯（admin-ui の SaveBar）を付ける囲み。
 * UI ルール v1.1 の 7章（docs/UI_RULES.md）。
 *
 * - 画面の入力は今までどおり React の状態で持ち、送る中身も今までどおり各画面の onSave が作る（この囲みは中身を変えない）。
 * - 状態を 1 つの隠し欄（JSON）に写し、SaveBar はその欄で「保存したときと違うか」を比べる（formSnapshot）。
 * - 「破棄」は最後に保存した値（開いた時点の値）に戻す。保存に失敗したときは帯をもう一度出す。
 * - 欄の中で Enter を押してもフォームを送らない（今までの画面と同じく、保存は帯の「保存」だけ）。
 * - 送ったあと画面の読み込みが終わっても新しい結果が来ない（サーバーの例外・通信の失敗など）ときも、失敗として帯を出し直す。
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigation } from "react-router";
import { SaveBar, markFormDirty } from "./admin-ui";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function StateSaveForm<T>({
  values,
  onSave,
  onDiscard,
  result,
  children,
}: {
  /** 保存の対象の今の値（画面の状態）。これが保存したときと違うと帯が出る */
  values: T;
  /** 帯の「保存」。false を返したら送らなかった（画面の入力の誤り）とみなし、帯をもう一度出す */
  onSave: () => boolean | void;
  /** 帯の「破棄」。最後に保存した値を渡すので、画面の状態をそれに戻す */
  onDiscard: (saved: T) => void;
  /** 保存の結果（useActionData）。ok が false なら失敗として帯をもう一度出す */
  result?: { ok?: boolean } | null;
  children: ReactNode;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const serialized = JSON.stringify(values);
  const saved = useRef<T>(values);
  const previousSaved = useRef<T>(values);
  const [failed, setFailed] = useState(false);
  const navigation = useNavigation();
  // 送ったあとの結果待ち。送った時点の result と、読み込み中になったかを覚えておく
  const awaiting = useRef<{ resultAtSubmit: unknown; sawBusy: boolean } | null>(null);

  // 状態が変わったら、隠し欄の値が描き直されたあとで帯に知らせる
  useIsoLayoutEffect(() => {
    markFormDirty(formRef.current?.querySelector("[data-state-snapshot]"));
  }, [serialized]);

  // 帯の「保存」「破棄」のボタンはフォームの中にあり、押されると（type の無い button なので）フォームを送ることがある。
  // 「保存」は SaveBar が requestSubmit() で送るので、ボタンからの送信は止める（二重に送る・「破棄」で送るのを防ぐ）
  useEffect(() => {
    const element = formRef.current;
    if (!element) return;
    const stopBarButtonSubmit = (event: SubmitEvent) => {
      if (event.submitter && event.submitter.closest("ui-save-bar")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    element.addEventListener("submit", stopBarButtonSubmit, true);
    return () => element.removeEventListener("submit", stopBarButtonSubmit, true);
  }, []);

  useEffect(() => {
    if (result && result.ok === false) {
      saved.current = previousSaved.current;
      setFailed(true);
    }
  }, [result]);

  // 読み込みが終わったのに新しい結果が無い = 保存できたか分からない。保存できなかったとして帯を出し直す
  useEffect(() => {
    const wait = awaiting.current;
    if (!wait) return;
    if (navigation.state !== "idle") {
      wait.sawBusy = true;
      return;
    }
    if (!wait.sawBusy) return;
    awaiting.current = null;
    if (result === wait.resultAtSubmit) {
      saved.current = previousSaved.current;
      setFailed(true);
    }
  }, [navigation.state, result]);

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setFailed(false);
    previousSaved.current = saved.current;
    saved.current = values;
    awaiting.current = { resultAtSubmit: result, sawBusy: false };
    if (onSave() === false) {
      awaiting.current = null;
      saved.current = previousSaved.current;
      // 送らなかったときも、そのまま直して保存し直せるよう帯を出し直す
      window.setTimeout(() => setFailed(true), 0);
    }
  };

  const blockEnter = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
  };

  return (
    <form ref={formRef} onSubmit={submit} onKeyDown={blockEnter} noValidate>
      <input type="hidden" name="__state" value={serialized} readOnly data-state-snapshot />
      <SaveBar failed={failed} onDiscard={() => onDiscard(saved.current)} />
      {children}
    </form>
  );
}
