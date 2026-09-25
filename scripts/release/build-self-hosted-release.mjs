#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const MANIFEST_NAME = "release-manifest.json";
const POLICY_NAME = "release-policy.json";
const ROLLBACK_NAME = "rollback.json";
const SCHEMA = "patchy.self-hosted-release/v1";
const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REQUIRED_FILES = Object.freeze([
  ".htaccess",
  "capabilities.css",
  "capabilities.html",
  "capabilities.mjs",
  "editor.css",
  "editor.mjs",
  "engine/client.mjs",
  "engine/index.mjs",
  "engine/protocol.mjs",
  "engine/worker.mjs",
  "patchy-engine.mjs",
  "patchy-engine.wasm",
  "patchy.html",
]);
const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-cache",
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:; connect-src 'self'; media-src 'none'; manifest-src 'self'; form-action 'none'",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});
const COMPRESSIBLE = /\.(?:css|data|js|mjs|svg|wasm)$/i;

const toPosix = (value) => value.split(sep).join("/");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const comparePaths = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function assertSafeRelativePath(path) {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe release path: ${path}`);
  }
}

function validateIdentity(releaseId, sourceSha) {
  if (!RELEASE_ID_PATTERN.test(releaseId) || releaseId === "." || releaseId === "..") {
    throw new Error(`invalid release id: ${releaseId}`);
  }
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new Error(`source SHA must be 40 lowercase hexadecimal characters: ${sourceSha}`);
  }
}

async function walkFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = toPosix(relative(root, absolute));
      assertSafeRelativePath(path);
      const status = await lstat(absolute);
      if (status.isSymbolicLink()) throw new Error(`symbolic links are forbidden in a release: ${path}`);
      if (status.isDirectory()) await visit(absolute);
      else if (status.isFile()) files.push(path);
      else throw new Error(`unsupported filesystem entry in release: ${path}`);
    }
  }
  await visit(root);
  return files.sort(comparePaths);
}

async function copyClosedTree(sourceRoot, destinationRoot) {
  for (const path of await walkFiles(sourceRoot)) {
    if ([MANIFEST_NAME, POLICY_NAME, ROLLBACK_NAME].includes(path) || path.startsWith("deploy/")) {
      throw new Error(`staged site contains reserved release metadata: ${path}`);
    }
    const destination = join(destinationRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(sourceRoot, path), destination);
  }
}

function policyFor(releaseId, sourceSha) {
  return {
    schema: SCHEMA,
    releaseId,
    sourceSha,
    dataBoundary: {
      mode: "local-first",
      documentUploads: "disabled",
      remoteDocumentApi: "disabled",
      originPrivateRecovery: "enabled",
    },
    runtime: {
      required: ["WebAssembly", "Worker", "SharedArrayBuffer", "crossOriginIsolated"],
      enhanced: ["OPFS", "OffscreenCanvas", "ImageBitmap", "FileSystemAccess"],
      crossOriginIsolation: "required",
    },
    support: {
      targetReleaseMatrix: ["Chrome", "Edge", "Firefox"],
      provisional: ["Safari"],
      rule: "Feature detection decides runtime readiness; release certification requires a separate completed browser gate.",
    },
    securityHeaders: SECURITY_HEADERS,
  };
}

function rollbackFor(releaseId, previousReleaseId) {
  if (previousReleaseId !== null && !RELEASE_ID_PATTERN.test(previousReleaseId)) {
    throw new Error(`invalid previous release id: ${previousReleaseId}`);
  }
  return {
    schema: SCHEMA,
    releaseId,
    immutableReleasePath: `/releases/${releaseId}/`,
    previousReleaseId,
    previousReleasePath: previousReleaseId === null ? null : `/releases/${previousReleaseId}/`,
    switchContract: "Change only the external current-release pointer after verification; never mutate a published release directory.",
  };
}

function deploymentFiles(releaseId, apacheConfig) {
  const csp = SECURITY_HEADERS["Content-Security-Policy"];
  return {
    "deploy/Caddyfile": `# Generated for immutable Patchy release ${releaseId}\nhandle_path /releases/${releaseId}/* {\n  root * /srv/patchy/releases/${releaseId}\n  header {\n    Cross-Origin-Opener-Policy \"same-origin\"\n    Cross-Origin-Embedder-Policy \"require-corp\"\n    Cross-Origin-Resource-Policy \"same-origin\"\n    Content-Security-Policy \"${csp}\"\n    Permissions-Policy \"${SECURITY_HEADERS["Permissions-Policy"]}\"\n    Referrer-Policy \"no-referrer\"\n    X-Content-Type-Options \"nosniff\"\n  }\n  @entry path *.html\n  header @entry Cache-Control \"no-cache\"\n  @asset path *.css *.js *.mjs *.wasm *.data *.svg *.png *.ico *.br *.gz\n  header @asset Cache-Control \"public, max-age=31536000, immutable\"\n  file_server {\n    precompressed br gzip\n  }\n}\n`,
    "deploy/apache.htaccess": apacheConfig,
    "deploy/nginx.conf": `# Generated for immutable Patchy release ${releaseId}\nlocation /releases/${releaseId}/ {\n  root /srv/patchy;\n  set $patchy_cache_control \"no-cache\";\n  if ($uri ~* \\.(?:css|js|mjs|wasm|data|svg|png|ico|br|gz)$) { set $patchy_cache_control \"public, max-age=31536000, immutable\"; }\n  gzip_static on;\n  # Enable brotli_static here when the optional nginx Brotli module is loaded.\n  add_header Cache-Control $patchy_cache_control always;\n  add_header Cross-Origin-Opener-Policy \"same-origin\" always;\n  add_header Cross-Origin-Embedder-Policy \"require-corp\" always;\n  add_header Cross-Origin-Resource-Policy \"same-origin\" always;\n  add_header Content-Security-Policy \"${csp}\" always;\n  add_header Permissions-Policy \"${SECURITY_HEADERS["Permissions-Policy"]}\" always;\n  add_header Referrer-Policy \"no-referrer\" always;\n  add_header X-Content-Type-Options \"nosniff\" always;\n  try_files $uri =404;\n}\n`,
  };
}

async function writeGeneratedFiles(root, releaseId, sourceSha, previousReleaseId) {
  await writeFile(join(root, POLICY_NAME), json(policyFor(releaseId, sourceSha)));
  await writeFile(join(root, ROLLBACK_NAME), json(rollbackFor(releaseId, previousReleaseId)));
  const apacheConfig = await readFile(join(root, ".htaccess"), "utf8");
  for (const [path, contents] of Object.entries(deploymentFiles(releaseId, apacheConfig))) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
}

async function writeCompressedVariants(root) {
  const candidates = (await walkFiles(root)).filter((path) => COMPRESSIBLE.test(path) && !/\.(?:br|gz)$/i.test(path));
  for (const path of candidates) {
    const source = await readFile(join(root, path));
    const brotli = brotliCompressSync(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 10,
        [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
        [constants.BROTLI_PARAM_LGWIN]: constants.BROTLI_MAX_WINDOW_BITS,
      },
    });
    await writeFile(join(root, `${path}.br`), brotli);
    await writeFile(join(root, `${path}.gz`), gzipSync(source, { level: constants.Z_BEST_COMPRESSION, mtime: 0 }));
  }
}

async function inventory(root) {
  const result = [];
  for (const path of await walkFiles(root)) {
    if (path === MANIFEST_NAME) continue;
    const bytes = await readFile(join(root, path));
    result.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return result;
}

export async function buildRelease({ siteDir, outputDir, releaseId, sourceSha, previousReleaseId = null }) {
  validateIdentity(releaseId, sourceSha);
  const sourceRoot = resolve(siteDir);
  const destinationRoot = resolve(outputDir);
  const sourceStatus = await lstat(sourceRoot);
  if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
    throw new Error(`staged site must be a real directory: ${sourceRoot}`);
  }
  const destinationFromSource = relative(sourceRoot, destinationRoot);
  if (destinationFromSource === "" || (!destinationFromSource.startsWith(`..${sep}`) &&
      destinationFromSource !== ".." && !isAbsolute(destinationFromSource))) {
    throw new Error("release output must be outside the staged site");
  }
  if (basename(destinationRoot) !== releaseId) {
    throw new Error(`release directory basename must equal release id ${releaseId}`);
  }
  try {
    await lstat(destinationRoot);
    throw new Error(`release directory already exists: ${destinationRoot}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stagingRoot = join(dirname(destinationRoot), `.${releaseId}.staging-${process.pid}`);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  try {
    await copyClosedTree(sourceRoot, stagingRoot);
    for (const path of REQUIRED_FILES) {
      try {
        const status = await lstat(join(stagingRoot, path));
        if (!status.isFile() || status.isSymbolicLink()) throw new Error();
      } catch {
        throw new Error(`staged site is missing required file: ${path}`);
      }
    }
    await writeGeneratedFiles(stagingRoot, releaseId, sourceSha, previousReleaseId);
    await writeCompressedVariants(stagingRoot);
    const files = await inventory(stagingRoot);
    const manifest = {
      schema: SCHEMA,
      releaseId,
      sourceSha,
      entrypoint: "patchy.html",
      immutableReleasePath: `/releases/${releaseId}/`,
      policy: POLICY_NAME,
      rollback: ROLLBACK_NAME,
      securityHeaders: SECURITY_HEADERS,
      files,
    };
    await writeFile(join(stagingRoot, MANIFEST_NAME), json(manifest));
    await mkdir(dirname(destinationRoot), { recursive: true });
    await rename(stagingRoot, destinationRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  return verifyRelease(destinationRoot);
}

export async function verifyRelease(releaseDir) {
  const root = resolve(releaseDir);
  const manifestStatus = await lstat(join(root, MANIFEST_NAME));
  if (!manifestStatus.isFile() || manifestStatus.isSymbolicLink()) {
    throw new Error("release manifest must be a regular file");
  }
  const manifest = JSON.parse(await readFile(join(root, MANIFEST_NAME), "utf8"));
  validateIdentity(manifest.releaseId, manifest.sourceSha);
  if (manifest.schema !== SCHEMA) throw new Error(`unsupported release schema: ${manifest.schema}`);
  if (basename(root) !== manifest.releaseId) throw new Error("release directory does not match manifest release id");
  if (manifest.entrypoint !== "patchy.html" || manifest.policy !== POLICY_NAME || manifest.rollback !== ROLLBACK_NAME) {
    throw new Error("release manifest contains an unsupported entrypoint or binding");
  }
  if (JSON.stringify(manifest.securityHeaders) !== JSON.stringify(SECURITY_HEADERS)) {
    throw new Error("release manifest security-header contract differs from the builder contract");
  }
  const declared = manifest.files.map((entry) => entry.path);
  if (new Set(declared).size !== declared.length || [...declared].sort(comparePaths).join("\n") !== declared.join("\n")) {
    throw new Error("release manifest paths must be unique and sorted");
  }
  for (const path of declared) assertSafeRelativePath(path);
  if (declared.includes(MANIFEST_NAME)) throw new Error("release manifest cannot hash itself");
  for (const path of REQUIRED_FILES) {
    if (!declared.includes(path)) throw new Error(`release manifest is missing required file: ${path}`);
  }
  const actual = (await walkFiles(root)).filter((path) => path !== MANIFEST_NAME);
  if (actual.join("\n") !== declared.join("\n")) throw new Error("release directory differs from the closed manifest inventory");
  for (const entry of manifest.files) {
    const bytes = await readFile(join(root, entry.path));
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`release file failed integrity verification: ${entry.path}`);
    }
    if (/\.(?:br|gz)$/i.test(entry.path) && !declared.includes(entry.path.replace(/\.(?:br|gz)$/i, ""))) {
      throw new Error(`compressed variant has no identity source: ${entry.path}`);
    }
  }
  const policy = JSON.parse(await readFile(join(root, POLICY_NAME), "utf8"));
  const rollback = JSON.parse(await readFile(join(root, ROLLBACK_NAME), "utf8"));
  if (policy.releaseId !== manifest.releaseId || policy.sourceSha !== manifest.sourceSha || policy.dataBoundary?.documentUploads !== "disabled") {
    throw new Error("release policy is not bound to the manifest or violates the local-first boundary");
  }
  if (rollback.releaseId !== manifest.releaseId || rollback.immutableReleasePath !== manifest.immutableReleasePath) {
    throw new Error("rollback contract is not bound to the manifest");
  }
  return { releaseId: manifest.releaseId, sourceSha: manifest.sourceSha, fileCount: manifest.files.length };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${flag ?? "end of command"}`);
    values.set(flag.slice(2), value);
  }
  return { command, values };
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command === "build") {
    const required = ["site", "output", "release-id", "source-sha"];
    for (const name of required) if (!values.has(name)) throw new Error(`missing --${name}`);
    const result = await buildRelease({
      siteDir: values.get("site"),
      outputDir: values.get("output"),
      releaseId: values.get("release-id"),
      sourceSha: values.get("source-sha"),
      previousReleaseId: values.get("previous-release-id") ?? null,
    });
    console.log(`built and verified ${result.releaseId}: ${result.fileCount} files`);
    return;
  }
  if (command === "verify") {
    if (!values.has("release") || values.size !== 1) throw new Error("usage: verify --release <release-dir>");
    const result = await verifyRelease(values.get("release"));
    console.log(`verified ${result.releaseId}: ${result.fileCount} files`);
    return;
  }
  throw new Error("usage: build --site <staged-site> --output <release-dir> --release-id <id> --source-sha <sha> [--previous-release-id <id>] | verify --release <release-dir>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`self-hosted release: ${error.message}`);
    process.exitCode = 1;
  });
}
