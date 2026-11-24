import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { JSDOM } from "jsdom";
import { NumField } from "../components/ReceiptLayoutEditor";

test("両用紙のロゴ初期値と補正ON直後の値は実DOMの制約検証を通る", () => {
  const cases = [
    { value: 62.5, min: 15 / 48 * 100, max: 42 / 48 * 100 },
    { value: 50, min: 15 / 72 * 100, max: 42 / 72 * 100 },
    { value: 100 * 25.4 / 96, min: 5, max: 60 },
    { value: 12, min: 5, max: 60 },
  ];
  for (const props of cases) {
    const markup = renderToStaticMarkup(React.createElement(AppProvider, { i18n: en },
      React.createElement("form", null, React.createElement(NumField, {
        ...props, label: "幅", step: "any", onChange() {},
      }))));
    const dom = new JSDOM(markup);
    const input = dom.window.document.querySelector("input")!;
    assert.equal(input.type, "number");
    assert.equal(input.step, "any");
    assert.equal(input.valueAsNumber, props.value, "保存済みの小数値を丸めない");
    assert.equal(input.validity.stepMismatch, false);
    assert.equal(dom.window.document.querySelector("form")!.checkValidity(), true);
    input.value = String(props.max + 1);
    assert.equal(input.validity.rangeOverflow, true, "範囲の保護は維持");
    dom.window.close();
  }
});
