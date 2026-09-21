import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";
import { PatchyWorkspaceStore } from "../../build/wasm-sdk/site/engine/workspace-store.mjs";
import { encodeFlatDocument } from "../../sdk/engine/flat-export.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
const workspaceStore = new PatchyWorkspaceStore();
const recoveryId = "wasm-format-psb-v1";

function check(value, message) {
  if (!value) throw new Error(message);
}

try {
  await client.initialize(moduleUrl.href);
  const created = await client.create(4, 3, "Formats.psd");
  const rgba = new Uint8Array(4 * 3 * 4);
  for (let pixel = 0; pixel < 12; ++pixel) {
    rgba.set([pixel * 17, 220 - pixel * 9, 30 + pixel * 11, pixel === 0 ? 96 : 255], pixel * 4);
  }
  const authored = await client.addPixelLayer({ name: "Format pixels", width: 4, height: 3,
    bounds: { x: 0, y: 0, width: 4, height: 3 }, rgba });
  check(authored.layers.length === 1, "authoring layer was not committed");

  const psd = await client.save("psd");
  const psb = await client.save("psb");
  check(psd[4] === 0 && psd[5] === 1, "PSD header version mismatch");
  check(psb[4] === 0 && psb[5] === 2, "PSB header version mismatch");
  const inspectedPsb = await client.inspectBlob(new Blob([psb]));
  check(inspectedPsb.version === 2 && inspectedPsb.width === 4 && inspectedPsb.height === 3,
    "PSB inspection mismatch");
  const reopened = await client.openBlob(new Blob([psb]), "Formats.psb");
  check(reopened.layers.length === 1 && reopened.width === 4 && reopened.height === 3,
    "PSB reopen lost authored state");
  const flattened = await client.render({ x: 0, y: 0, width: 4, height: 3 });
  check(flattened.byteLength === 48, "full-document render was incomplete");

  const exportInput = { rgba: flattened, width: 4, height: 3, title: "Formats <whole>" };
  const png = await encodeFlatDocument({ ...exportInput, format: "png" });
  const jpeg = await encodeFlatDocument({ ...exportInput, format: "jpeg" });
  const webp = await encodeFlatDocument({ ...exportInput, format: "webp" });
  const svgBlob = await encodeFlatDocument({ ...exportInput, format: "svg" });
  check(png.size > 8 && jpeg.size > 2 && webp.size > 12, "flat browser codec returned empty output");
  const pngHead = new Uint8Array(await png.slice(0, 8).arrayBuffer());
  const jpegHead = new Uint8Array(await jpeg.slice(0, 2).arrayBuffer());
  const webpHead = new TextDecoder().decode(await webp.slice(0, 12).arrayBuffer());
  check(pngHead[0] === 0x89 && pngHead[1] === 0x50, "PNG signature mismatch");
  check(jpegHead[0] === 0xff && jpegHead[1] === 0xd8, "JPEG signature mismatch");
  check(webpHead.startsWith("RIFF") && webpHead.endsWith("WEBP"), "WebP signature mismatch");
  const svg = await svgBlob.text();
  const parsedSvg = new DOMParser().parseFromString(svg, "image/svg+xml");
  check(svgBlob.type === "image/svg+xml" && parsedSvg.documentElement.localName === "svg" &&
    parsedSvg.querySelector("title")?.textContent === "Formats <whole>" &&
    parsedSvg.querySelector("image")?.getAttribute("href")?.startsWith("data:image/png"),
  "flattened SVG wrapper mismatch");

  await client.activateDocument(created.documentId);
  const psbBlob = await client.saveBlob("psb");
  const psbBlobHead = new Uint8Array(await psbBlob.slice(0, 6).arrayBuffer());
  check(psbBlobHead[4] === 0 && psbBlobHead[5] === 2, "PSB Blob header mismatch");
  try { await workspaceStore.remove(recoveryId); } catch { /* Clean first run. */ }
  await workspaceStore.checkpoint({ id: recoveryId, name: "Renamed.psd", revision: 4n,
    dirty: true, format: "psb", bytes: psb });
  const recovered = await workspaceStore.restore(recoveryId);
  check(recovered.manifest.name === "Renamed.psd" && recovered.manifest.format === "psb" &&
    recovered.bytes[5] === 2, "PSB recovery lost byte-derived format identity");
  const recoveredDocument = await client.open(recovered.bytes, recovered.manifest.name);
  check(recoveredDocument.layers.length === 1, "PSB recovery lost the authored layer");
  const recoveredPsb = await client.save("psb");
  check(recoveredPsb[5] === 2, "recovered mismatched-name PSB did not remain PSB");
  await workspaceStore.remove(recoveryId);
  body.dataset.result = "PASS";
  body.textContent = `PASS psd=${psd.length} psb=${psb.length} png=${png.size} jpeg=${jpeg.size} webp=${webp.size} svg=${svg.length}`;
} catch (error) {
  body.dataset.result = "FAIL";
  body.textContent = `FAIL ${error?.stack || error}`;
} finally {
  client.terminate();
}
