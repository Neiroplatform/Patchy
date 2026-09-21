import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";
import { applyParagraphStyleRange, justifiedSpaceAdvance } from
  "../../build/wasm-sdk/site/text-layout.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
const check = (value, message) => { if (!value) throw new Error(message); };
const style = (start, length, font, sizePixels, color, extra = {}) => ({ start, length,
  font, style: "", sizePixels, color, bold: false, italic: false, fauxBold: false,
  fauxItalic: false, leading: 0, autoLeading: true, tracking: 0,
  horizontalScale: 1, verticalScale: 1, ...extra });
const paragraph = (start, length, justification, extra = {}) => ({ start, length,
  justification, firstLineIndent: 0, startIndent: 0, endIndent: 0,
  spaceBefore: 0, spaceAfter: 0, autoLeadingFraction: 1.2, ...extra });

try {
  const paragraphUiRuns = applyParagraphStyleRange(
    [paragraph(0, 6, 0), paragraph(6, 5, 0)], 6, 11,
    paragraph(6, 5, 2, { startIndent: 2 }));
  check(paragraphUiRuns.length === 2 && paragraphUiRuns[0].justification === 0 &&
    paragraphUiRuns[1].justification === 2 &&
    justifiedSpaceAdvance(3, 100, 70, [{ value: "one two three" }]) === 15,
  "browser paragraph range or justify layout contract failed");
  await client.initialize(moduleUrl.href);
  await client.create(12, 6, "Rich text.psd");
  const firstPixels = new Uint8Array(10 * 3 * 4);
  for (let offset = 0; offset < firstPixels.length; offset += 4)
    firstPixels.set([20, 40, 200, 255], offset);
  let snapshot = await client.addTextLayer({ name: "Mixed text", text: "Hello world",
    font: "Inter", sizePixels: 20, color: [20, 40, 200], bold: true, italic: false,
    boxText: true, width: 10, height: 3, bounds: { x: 1, y: 1, width: 10, height: 3 },
    rgba: firstPixels,
    styleRuns: [style(0, 5, "Inter", 20, [20, 40, 200], { bold: true, tracking: 30 }),
      style(5, 6, "Georgia", 14, [220, 50, 40], { italic: true, leading: 18, autoLeading: false })],
    paragraphRuns: [paragraph(0, 11, 2, { startIndent: 1, endIndent: 1 })] },
  { transferOwnership: true });
  const layerId = snapshot.activeLayerId;
  let projected = snapshot.layers.find((layer) => layer.id === layerId)?.text;
  check(firstPixels.byteLength === 0 && projected?.styleRuns.length === 2 &&
    projected.styleRuns[1].font === "Georgia" && projected.paragraphRuns[0].justification === 2,
  "mixed text did not cross the Worker/WASM boundary");

  const editedPixels = new Uint8Array(10 * 3 * 4);
  for (let offset = 0; offset < editedPixels.length; offset += 4)
    editedPixels.set([30, 180, 90, 255], offset);
  snapshot = await client.updateTextLayer(layerId, { name: "Mixed text", text: "Hello\nworld",
    font: "Inter", sizePixels: 22, color: [30, 180, 90], bold: false, italic: false,
    boxText: true, width: 10, height: 3, bounds: { x: 1, y: 1, width: 10, height: 3 },
    rgba: editedPixels,
    styleRuns: [style(0, 6, "Inter", 22, [30, 180, 90], { tracking: 15 }),
      style(6, 5, "Courier New", 16, [240, 180, 20], { bold: true })],
    paragraphRuns: [paragraph(0, 6, 0, { spaceAfter: 1 }),
      paragraph(6, 5, 1, { firstLineIndent: 2, autoLeadingFraction: 1.35 })] },
  { transferOwnership: true });
  projected = snapshot.layers.find((layer) => layer.id === layerId)?.text;
  check(snapshot.revision > 1n && projected?.value === "Hello\nworld" &&
    projected.styleRuns[1].font === "Courier New" && projected.paragraphRuns[1].justification === 1,
  "rich text update was not one projected revision");
  const editedRevision = snapshot.revision;
  const undone = await client.undo(); const redone = await client.redo();
  check(undone.layers.find((layer) => layer.id === layerId)?.text.styleRuns[1].font === "Georgia" &&
    redone.layers.find((layer) => layer.id === layerId)?.text.styleRuns[1].font === "Courier New" &&
    redone.revision > undone.revision, "rich text undo/redo did not restore exact state");

  const expectedPixels = await client.layerPixels(layerId);
  const psd = await client.save("psd"); const psb = await client.save("psb");
  const reopenedPsd = await client.open(psd, "Reopened rich text.psd");
  let reopenedLayer = reopenedPsd.layers.find((layer) => layer.name === "Mixed text");
  check(reopenedLayer?.text.styleRuns[1].font === "Courier New" &&
    reopenedLayer.text.paragraphRuns[1].justification === 1 &&
    (await client.layerPixels(reopenedLayer.id)).every((value, index) => value === expectedPixels[index]),
  "PSD reopen lost rich text runs or raster cache");
  const reopenedPsb = await client.open(psb, "Reopened rich text.psb");
  reopenedLayer = reopenedPsb.layers.find((layer) => layer.name === "Mixed text");
  check(psb[5] === 2 && reopenedLayer?.text.styleRuns[1].font === "Courier New" &&
    reopenedLayer.text.paragraphRuns[1].autoLeadingFraction === 1.35,
  "PSB reopen lost rich text semantics");
  body.dataset.result = "PASS";
  body.textContent = `PASS revision=${editedRevision} runs=${reopenedLayer.text.styleRuns.length} paragraphs=${reopenedLayer.text.paragraphRuns.length} paragraphUI=${paragraphUiRuns.length} psd=${psd.length} psb=${psb.length}`;
} catch (error) {
  body.dataset.result = "FAIL"; body.textContent = `FAIL ${error?.stack || error}`;
} finally { client.terminate(); }
