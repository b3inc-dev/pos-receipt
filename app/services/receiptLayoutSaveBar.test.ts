import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";

const bridge = { toast: { show() {} } };
mock.module("@shopify/app-bridge-react", { namedExports: {
  SaveBar: (props: object) => React.createElement("mock-save-bar", props),
  useAppBridge: () => bridge,
} });
const { SaveBar } = await import("../components/admin-ui");

test("保存値を管理する画面: 保存後の表示入力の変化で帯を出し直さず、次の編集と保存失敗は保持する", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFormData = globalThis.FormData;
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, "Element");
  const listeners = new Map<string, EventListener>();
  let snapshot = "58mm/style-tab";
  const frames: (() => void)[] = [];
  const timers: (() => void)[] = [];
  const form = {
    addEventListener: (type: string, fn: EventListener) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
  } });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: class {} });
  globalThis.FormData = class { *[Symbol.iterator]() { yield ["layout", snapshot]; } } as any;
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(SaveBar, { hasChanges: false }), {
      createNodeMock: () => ({ closest: () => form }),
    }); timers.splice(0).forEach((fn) => fn()); });
    const open = () => renderer!.root.findByType("mock-save-bar" as any).props.open;
    assert.equal(open(), false);
    await act(async () => { renderer!.update(React.createElement(SaveBar, { hasChanges: true })); });
    assert.equal(open(), true, "58mmの編集は未保存として表示する");
    await act(async () => { listeners.get("submit")!(new Event("submit")); });
    await act(async () => { renderer!.update(React.createElement(SaveBar, { hasChanges: false })); });
    snapshot = "58mm/blocks-tab"; // 保存応答後のエディタ再描画。保存値自体は変わらない。
    await act(async () => {
      listeners.get("change")!(new Event("change"));
      frames.splice(0).forEach((fn) => fn());
    });
    assert.equal(open(), false, "表示用DOMの変更は再保存を要求しない");
    await act(async () => { renderer!.update(React.createElement(SaveBar, { hasChanges: true, failed: true })); });
    assert.equal(open(), true, "保存失敗・次の編集では帯を維持する");
    await act(async () => { renderer!.update(React.createElement(SaveBar, { hasChanges: false })); });
    assert.equal(open(), false, "破棄して保存済み値に戻すと閉じる");
    await act(async () => { renderer!.update(React.createElement(SaveBar, {})); });
    assert.equal(open(), true, "指定しない既存画面はDOMによる変更判定を維持する");
  } finally {
    await act(async () => renderer?.unmount());
    globalThis.FormData = originalFormData;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalElement) Object.defineProperty(globalThis, "Element", originalElement);
    else Reflect.deleteProperty(globalThis, "Element");
  }
});
