import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { anchoredScrollDelta, clampScrollPosition, clampZoom, fitZoom, rulerStep,
  rulerTicks } from "../../sdk/engine/site/viewport-model.mjs";

test("fit and manual zoom remain finite and bounded", () => {
  assert.equal(fitZoom({ width: 1600, height: 1000 }, { width: 880, height: 580 }, 40), .5);
  assert.equal(fitZoom({ width: 100, height: 100 }, { width: 1000, height: 1000 }), 1);
  assert.equal(fitZoom({ width: 0, height: 10 }, { width: 100, height: 100 }), 1);
  assert.equal(clampZoom(-1), .05);
  assert.equal(clampZoom(Infinity), 1);
  assert.equal(clampZoom(90), 8);
});

test("scroll positions clamp hostile and out-of-bounds values", () => {
  assert.deepEqual(clampScrollPosition({ x: -40, y: 900 },
    { width: 1200, height: 900 }, { width: 800, height: 600 }), { x: 0, y: 300 });
  assert.deepEqual(clampScrollPosition({ x: NaN, y: Infinity },
    { width: 1200, height: 900 }, { width: 800, height: 600 }), { x: 0, y: 0 });
  assert.deepEqual(clampScrollPosition({ x: 20, y: 30 },
    { width: 400, height: 300 }, { width: 800, height: 600 }), { x: 0, y: 0 });
});

test("anchored zoom preserves the observed document point", () => {
  const anchor = { x: 400, y: 300 };
  const delta = anchoredScrollDelta(
    { left: 100, top: 50, width: 600, height: 500 },
    { left: -200, top: -200, width: 1200, height: 1000 }, anchor);
  assert.deepEqual(delta, { x: 0, y: 0 });
  assert.deepEqual(anchoredScrollDelta({}, {}, anchor), { x: 0, y: 0 });
});

test("ruler ticks use deterministic 1-2-5 steps and a finite cap", () => {
  assert.equal(rulerStep(1), 100);
  assert.equal(rulerStep(2), 50);
  assert.equal(rulerStep(.1), 1000);
  assert.deepEqual(rulerTicks({ start: 90, end: 310, zoom: 1, screenOrigin: 7 }), [
    { value: 100, screen: 17, major: true },
    { value: 200, screen: 117, major: true },
    { value: 300, screen: 217, major: true },
  ]);
  assert.equal(rulerTicks({ start: 0, end: 1e9, zoom: .05, maximum: 9 }).length, 9);
});

test("production viewport contract is staged and navigation is render-free", async () => {
  const root = new URL("../../", import.meta.url);
  const [cmake, html, editor, css] = await Promise.all([
    readFile(new URL("CMakeLists.txt", root), "utf8"),
    readFile(new URL("sdk/engine/site/patchy.html", root), "utf8"),
    readFile(new URL("sdk/engine/site/editor.mjs", root), "utf8"),
    readFile(new URL("sdk/engine/site/editor.css", root), "utf8"),
  ]);
  assert.match(cmake, /sdk\/engine\/site\/viewport-model\.mjs/);
  assert.match(html, /id="horizontalRuler"/);
  assert.match(html, /id="zoomActualButton"/);
  assert.match(editor, /__patchyViewportDiagnostics/);
  assert.match(editor, /scheduleViewportUpdate/);
  assert.match(css, /canvas-frame::before/);
});
