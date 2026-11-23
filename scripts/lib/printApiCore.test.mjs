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
      /紙が出たか確かめて/,
    );
    assert.match(
      printResultMessage({ outcome: PRINT_OUTCOME.DIALOG_PRESENTED }),
      /印刷の画面を開きました/,
    );
    assert.match(
      printResultMessage({ outcome: PRINT_OUTCOME.NO_CONNECTED_PRINTER }),
      /つながっているレシートプリンタがありません/,
    );
  });

  it("店の人に見せる文に、仕組みの名前や開発の言葉を出さない（T さん 11/23）", () => {
    const texts = [
      ...Object.values(PRINT_OUTCOME).map((outcome) => printResultMessage({ outcome, extraConnected: 1 })),
      mapPrinterErrorMessage("out of paper"),
      mapPrinterErrorMessage("Printer disconnected"),
      mapPrinterErrorMessage("timeout"),
    ];
    for (const t of texts) {
      assert.doesNotMatch(t, /API|HTML|api_version|ダイアログ|成否|成功扱い|排出|再送|接続機/, t);
    }
  });

  it("maps paper-out and disconnect errors", () => {
    assert.match(mapPrinterErrorMessage("out of paper"), /用紙が切れて/);
    assert.match(mapPrinterErrorMessage("Printer disconnected"), /つながっていません/);
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

describe("printer discovery timeout", () => {
  it("releases the receipt and ignores a late printer list after a retry", async (t) => {
    const { printHtml, PRINT_TIMEOUT_MS } = await import("../../extensions/common/printApi.js");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const oldShopify = globalThis.shopify;
    t.after(() => {
      if (oldShopify === undefined) delete globalThis.shopify;
      else globalThis.shopify = oldShopify;
    });
    const printer = { connected: true, id: "test" };
    let finishDiscovery;
    let discoveries = 0;
    let sends = 0;
    globalThis.shopify = { printing: {
      getPrinters: () => ++discoveries === 1
        ? new Promise((resolve) => { finishDiscovery = resolve; })
        : Promise.resolve([printer]),
      print: async () => { sends++; },
    } };
    const first = printHtml("/fixture");
    assert.equal((await printHtml("/fixture")).outcome, PRINT_OUTCOME.IN_FLIGHT);
    t.mock.timers.tick(PRINT_TIMEOUT_MS);
    const result = await first;
    assert.equal(result.outcome, PRINT_OUTCOME.FAILED);
    assert.match(result.error, /まだ印刷していません/);
    assert.equal(sends, 0);
    assert.equal((await printHtml("/fixture")).outcome, PRINT_OUTCOME.DIRECT_ACCEPTED);
    finishDiscovery([printer]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sends, 1);
  });
});

it("a native discovery error is reported as unsent even if the system dialog was allowed", async (t) => {
  const { printHtml } = await import("../../extensions/common/printApi.js");
  const previous = globalThis.shopify;
  t.after(() => {
    if (previous === undefined) delete globalThis.shopify;
    else globalThis.shopify = previous;
  });
  let sends = 0;
  for (const reason of ["request timed out", "printer disconnected", "unknown"]) {
    globalThis.shopify = { printing: {
      getPrinters: async () => { throw new Error(reason); },
      print: async () => { sends++; },
    } };
    const result = await printHtml("/fixture", { allowDialog: true });
    assert.equal(result.outcome, PRINT_OUTCOME.FAILED);
    assert.match(printResultMessage(result), /まだ印刷していません/);
  }
  assert.equal(sends, 0);
});
