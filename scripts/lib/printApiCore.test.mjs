import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PRINT_OUTCOME,
  classifyPrinters,
  mapPrinterErrorMessage,
  pickDirectPrinter,
  printResultMessage,
  withTimeout,
} from "../../extensions/common/printApiCore.js";

describe("printApiCore printer selection", () => {
  it("uses only connected:true printers", () => {
    const classified = classifyPrinters([
      { id: "a", connected: false, name: "offline" },
      { id: "b", connected: true, name: "mC-Print3" },
      { id: "c", connected: true, name: "mPOP" },
    ]);
    assert.equal(classified.connectedCount, 2);
    assert.equal(classified.disconnectedCount, 1);
    assert.equal(pickDirectPrinter(classified.connected.concat(classified.disconnected)).id, "b");
  });

  it("does not fall back to a disconnected list[0]", () => {
    assert.equal(
      pickDirectPrinter([{ id: "x", connected: false }, { id: "y" }]),
      null,
    );
  });

  it("accepts { printers: [] } from getPrinters wrappers", () => {
    assert.equal(classifyPrinters({ printers: [] }).connectedCount, 0);
    assert.equal(pickDirectPrinter({ printers: [{ connected: true, id: "z" }] }).id, "z");
  });
});

describe("printApiCore outcomes", () => {
  it("distinguishes direct accept from dialog", () => {
    assert.match(
      printResultMessage({ outcome: PRINT_OUTCOME.DIRECT_ACCEPTED, extraConnected: 0 }),
      /排出完了は未確認/,
    );
    assert.match(
      printResultMessage({ outcome: PRINT_OUTCOME.DIALOG_PRESENTED }),
      /直接印字の成功ではありません/,
    );
    assert.match(
      printResultMessage({ outcome: PRINT_OUTCOME.NO_CONNECTED_PRINTER }),
      /成功扱い/,
    );
  });

  it("maps paper-out and disconnect errors", () => {
    assert.match(mapPrinterErrorMessage("out of paper"), /用紙切れ/);
    assert.match(mapPrinterErrorMessage("Printer disconnected"), /切断|オフライン/);
  });

  it("times out without swallowing the original later resolution as success", async () => {
    let resolved = false;
    const slow = new Promise((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve("late");
      }, 50);
    });
    await assert.rejects(
      () => withTimeout(slow, 5),
      (err) => err.code === "PRINT_TIMEOUT",
    );
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(resolved, true);
  });
});
