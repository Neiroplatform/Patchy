const body = document.body;
const frame = document.querySelector("#editorFrame");
const check = (value, message) => { if (!value) throw new Error(message); };
const delay = (milliseconds = 25) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, message, timeout = 60_000) {
  const deadline = performance.now() + timeout;
  let lastError;
  while (performance.now() < deadline) {
    try { if (await predicate()) return; } catch (error) { lastError = error; }
    await delay();
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

const build = new URL(location.href).searchParams.get("build") || "wasm-sdk";
const siteUrl = new URL(`../../build/${encodeURIComponent(build)}/site/`, import.meta.url);
const { PatchyWorkspaceStore } = await import(new URL("engine/workspace-store.mjs", siteUrl));
const store = new PatchyWorkspaceStore();
const names = { gradient: "RC Aurora", pattern: "RC Grid", font: "RC Mono" };
let createdIds = [];

async function cleanup() {
  const library = await store.loadAssetLibrary().catch(() => null);
  if (!library) return;
  for (const [kind, assets] of [["gradients", library.gradients], ["patterns", library.patterns],
    ["fonts", library.fonts]]) {
    for (const asset of assets) {
      if (createdIds.includes(asset.id) || [asset.name, asset.family].includes(names.gradient) ||
          [asset.name, asset.family].includes(names.pattern) ||
          [asset.name, asset.family].includes(names.font)) {
        await store.removeAsset(kind, asset.id);
      }
    }
  }
}

async function loadEditor(tag) {
  const loaded = new Promise((resolve, reject) => {
    frame.addEventListener("load", resolve, { once: true });
    frame.addEventListener("error", () => reject(new Error("editor iframe failed to load")), { once: true });
  });
  frame.src = `../../build/${encodeURIComponent(build)}/site/patchy.html?asset-library-smoke=${tag}-${Date.now()}`;
  await loaded;
  const doc = frame.contentDocument;
  await waitFor(() => doc.querySelector(".editor-shell")?.dataset.state === "ready" &&
    doc.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  "production editor did not initialize its pthread-WASM worker");
  return doc;
}

function assignFile(input, file, view) {
  const transfer = new view.DataTransfer();
  transfer.items.add(file);
  Object.defineProperty(input, "files", { configurable: true, value: transfer.files });
  input.dispatchEvent(new view.Event("change", { bubbles: true }));
}

try {
  await cleanup();
  let doc = await loadEditor("author");
  let byId = (id) => doc.getElementById(id);
  const view = () => frame.contentWindow;
  const idle = () => doc.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true";
  const revision = () => BigInt(byId("detailRevision").textContent);

  byId("assetsButton").click();
  await waitFor(() => byId("assetsDialog").open, "Assets dialog did not open");
  byId("assetGradientNameInput").value = names.gradient;
  byId("assetGradientStartInput").value = "#123456";
  byId("assetGradientEndInput").value = "#f4c542";
  byId("saveGradientAssetButton").click();
  await waitFor(() => [...byId("paintPresetSelect").options]
    .some((option) => option.textContent === `Gradient: ${names.gradient}`),
  "custom gradient did not enter the production asset library");

  byId("assetPatternNameInput").value = names.pattern;
  byId("assetPatternKindInput").value = "checker";
  byId("assetPatternForegroundInput").value = "#253891";
  byId("assetPatternBackgroundInput").value = "#e8eefc";
  byId("assetPatternSizeInput").value = "6";
  byId("savePatternAssetButton").click();
  await waitFor(() => [...byId("paintPresetSelect").options]
    .some((option) => option.textContent === `Pattern: ${names.pattern}`),
  "custom pattern did not enter the production asset library");

  const fontResponse = await fetch("../../third_party/fonts-web/liberation/LiberationMono-Regular.ttf");
  check(fontResponse.ok, "local font fixture could not be loaded");
  const fontBytes = await fontResponse.arrayBuffer();
  const fontFile = new (view().File)([fontBytes], "LiberationMono-Regular.ttf", { type: "font/ttf" });
  byId("assetFontFamilyInput").value = names.font;
  assignFile(byId("assetFontFileInput"), fontFile, view());
  byId("installFontAssetButton").click();
  await waitFor(() => [...byId("fontPresetList").options].some((option) => option.value === names.font) &&
    doc.fonts.check(`12px "${names.font}"`), "local font was not installed and activated");

  let library = await store.loadAssetLibrary();
  const gradient = library.gradients.find((asset) => asset.name === names.gradient);
  const pattern = library.patterns.find((asset) => asset.name === names.pattern);
  const font = library.fonts.find((asset) => asset.family === names.font);
  check(gradient && pattern && font, "persisted asset manifest is incomplete");
  createdIds = [gradient.id, pattern.id, font.id];
  check((await store.loadFont(font.id)).bytes.byteLength === fontBytes.byteLength,
    "persisted font bytes failed the digest-bound reload");
  byId("assetsDialog").querySelector('button[value="cancel"]').click();

  byId("newButton").click();
  await waitFor(() => idle() && !byId("importLayerButton").disabled, "New did not create a document");
  const svg = new (view().File)([
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="32"><rect width="48" height="32" fill="#48668c"/></svg>',
  ], "asset-target.svg", { type: "image/svg+xml" });
  assignFile(byId("imageInput"), svg, view());
  await waitFor(() => idle() && !byId("fillToolButton").disabled, "asset fill target was not imported");

  byId("paintPresetSelect").value = `asset:${gradient.id}`;
  let before = revision();
  byId("fillToolButton").click();
  await waitFor(() => idle() && revision() === before + 1n && byId("errorBanner").hidden,
    "custom gradient fill did not commit one engine revision");
  byId("paintPresetSelect").value = `asset:${pattern.id}`;
  before = revision();
  byId("fillToolButton").click();
  await waitFor(() => idle() && revision() === before + 1n && byId("errorBanner").hidden,
    "custom pattern fill did not commit one engine revision");
  const committedPixels = byId("documentCanvas").toDataURL();

  doc = await loadEditor("reload");
  byId = (id) => doc.getElementById(id);
  library = await store.loadAssetLibrary();
  check(library.gradients.some((asset) => asset.id === gradient.id) &&
    library.patterns.some((asset) => asset.id === pattern.id) &&
    library.fonts.some((asset) => asset.id === font.id),
  "asset library did not survive a production editor reload");
  check([...byId("paintPresetSelect").options].some((option) => option.value === `asset:${gradient.id}`) &&
    [...byId("paintPresetSelect").options].some((option) => option.value === `asset:${pattern.id}`),
  "reloaded fill controls did not expose persisted assets");
  check([...byId("fontPresetList").options].some((option) => option.value === names.font) &&
    doc.fonts.check(`12px "${names.font}"`), "reloaded editor did not reactivate the persisted font");

  await cleanup();
  body.dataset.result = "PASS";
  body.textContent = `PASS gradient=1 pattern=1 font=1 reload=1 fills=2 pixels=${committedPixels.length}`;
} catch (error) {
  await cleanup().catch(() => {});
  body.dataset.result = "FAIL";
  body.dataset.error = String(error?.stack || error);
  const failure = document.createElement("pre");
  failure.textContent = body.dataset.error;
  body.prepend(failure);
}
