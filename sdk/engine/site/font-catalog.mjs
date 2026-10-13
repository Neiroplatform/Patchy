const family = (name, directory, faces) => Object.freeze({
  family: name,
  faces: Object.freeze(faces.map(([filename, weight = "400", style = "normal"]) => Object.freeze({
    source: `fonts/${directory}/${filename}`,
    weight,
    style,
  }))),
});

export const BUNDLED_FONT_CATALOG = Object.freeze([
  family("Abril Fatface", "abril_fatface", [["AbrilFatface-Regular.ttf"]]),
  family("Carlito", "carlito", [["Carlito-Regular.ttf"], ["Carlito-Bold.ttf", "700"],
    ["Carlito-Italic.ttf", "400", "italic"], ["Carlito-BoldItalic.ttf", "700", "italic"]]),
  family("Caveat", "caveat", [["Caveat-Regular.ttf"], ["Caveat-Bold.ttf", "700"]]),
  family("Liberation Mono", "liberation", [["LiberationMono-Regular.ttf"],
    ["LiberationMono-Bold.ttf", "700"], ["LiberationMono-Italic.ttf", "400", "italic"],
    ["LiberationMono-BoldItalic.ttf", "700", "italic"]]),
  family("Liberation Sans", "liberation", [["LiberationSans-Regular.ttf"],
    ["LiberationSans-Bold.ttf", "700"], ["LiberationSans-Italic.ttf", "400", "italic"],
    ["LiberationSans-BoldItalic.ttf", "700", "italic"]]),
  family("Liberation Serif", "liberation", [["LiberationSerif-Regular.ttf"],
    ["LiberationSerif-Bold.ttf", "700"], ["LiberationSerif-Italic.ttf", "400", "italic"],
    ["LiberationSerif-BoldItalic.ttf", "700", "italic"]]),
  family("Lobster", "lobster", [["Lobster-Regular.ttf"]]),
  family("Montserrat", "montserrat", [["Montserrat-Regular.ttf"], ["Montserrat-Bold.ttf", "700"]]),
  family("Noto Sans", "noto_sans", [["NotoSans-Regular.ttf"], ["NotoSans-Bold.ttf", "700"],
    ["NotoSans-Italic.ttf", "400", "italic"], ["NotoSans-BoldItalic.ttf", "700", "italic"]]),
  family("Noto Sans JP", "noto_sans_jp", [["NotoSansJP-Regular.ttf"], ["NotoSansJP-Bold.ttf", "700"]]),
  family("Noto Serif", "noto_serif", [["NotoSerif-Regular.ttf"], ["NotoSerif-Bold.ttf", "700"],
    ["NotoSerif-Italic.ttf", "400", "italic"], ["NotoSerif-BoldItalic.ttf", "700", "italic"]]),
  family("Oswald", "oswald", [["Oswald-Regular.ttf"], ["Oswald-Bold.ttf", "700"]]),
  family("Pacifico", "pacifico", [["Pacifico-Regular.ttf"]]),
]);

export const BUNDLED_FONT_FAMILIES = Object.freeze(BUNDLED_FONT_CATALOG.map(({ family: name }) => name));

export async function loadBundledFontFamily(name, {
  FontFaceClass = globalThis.FontFace,
  fontSet = globalThis.document?.fonts,
  baseUrl = import.meta.url,
} = {}) {
  const entry = BUNDLED_FONT_CATALOG.find(({ family: candidate }) => candidate === name);
  if (!entry) return [];
  if (typeof FontFaceClass !== "function" || !fontSet?.add) {
    throw new Error("This browser cannot load the bundled font catalog.");
  }
  const loaded = [];
  for (const face of entry.faces) {
    const source = new URL(face.source, baseUrl);
    if (source.origin !== new URL(baseUrl).origin) throw new Error("Bundled fonts must stay same-origin.");
    const fontFace = new FontFaceClass(entry.family, `url("${source.href}")`, {
      weight: face.weight,
      style: face.style,
      display: "swap",
    });
    loaded.push(await fontFace.load());
  }
  for (const fontFace of loaded) fontSet.add(fontFace);
  return loaded;
}
