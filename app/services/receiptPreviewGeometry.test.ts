import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { ReceiptLayoutPreview } from "../components/ReceiptLayoutPreview";

test("補正プレビューは400pxのまま描画し、外側だけ縮小する。狭い画面でも折り返しを変えない", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let onResize: (() => void) | undefined;
  let available = 600;
  let bodyHeight = 1200;
  const frames: (() => void)[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    addEventListener: (_: string, fn: () => void) => { onResize = fn; },
    removeEventListener() {},
    requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame() {},
  } });
  let view: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { view = create(React.createElement(ReceiptLayoutPreview, {
      html: "<p>長い店舗名</p>", widthPx: 181, viewportPx: 400,
    }), { createNodeMock: (node) => node.type === "iframe"
      ? { contentDocument: { body: { get scrollHeight() { return bodyHeight; } } } }
      : { get clientWidth() { return available; } } }); });
    const frame = () => view!.root.findByType("iframe");
    const paper = () => view!.root.findByProps({ className: "RL-preview-paper" });
    assert.equal(frame().props.style.width, 400);
    assert.equal(paper().props.style.transform, "scale(0.4525)");
    await act(async () => { frame().props.onLoad(); });
    assert.equal(frame().props.style.height, 1204);
    bodyHeight = 2600;
    await act(async () => { view!.update(React.createElement(ReceiptLayoutPreview, { html: "<p>長い店舗名</p>", widthPx: 181, viewportPx: 181 })); });
    await act(async () => { frames.splice(0).forEach((fn) => fn()); });
    assert.equal(frame().props.style.height, 2604, "同じHTMLで補正解除しても末尾まで広げる");
    bodyHeight = 800;
    await act(async () => { view!.update(React.createElement(ReceiptLayoutPreview, { html: "<p>長い店舗名</p>", widthPx: 181, viewportPx: 400 })); });
    await act(async () => { frames.splice(0).forEach((fn) => fn()); });
    assert.equal(frame().props.style.height, 804, "補正を戻すと余分な高さも減らす");
    available = 100;
    await act(async () => { onResize?.(); });
    assert.equal(frame().props.style.width, 400);
    assert.ok(Number(paper().props.style.transform.match(/scale\((.*)\)/)[1]) < 0.4525);
  } finally {
    await act(async () => view?.unmount());
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
