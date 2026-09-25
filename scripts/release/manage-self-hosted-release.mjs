#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRelease } from "./build-self-hosted-release.mjs";

const POINTER_NAME = "current-release.json";
const POINTER_SCHEMA = "patchy.current-release/v1";
const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function assertReleaseId(releaseId) {
  if (!RELEASE_ID_PATTERN.test(releaseId) || releaseId === "." || releaseId === "..") {
    throw new Error(`invalid release id: ${releaseId}`);
  }
}

function assertContained(root, target, label) {
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} must be a child of the host root`);
  }
}

async function requireRealDirectory(path, label) {
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${path}`);
}

async function walkFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const status = await lstat(absolute);
      if (status.isSymbolicLink()) throw new Error(`symbolic links are forbidden: ${relative(root, absolute)}`);
      if (status.isDirectory()) await visit(absolute);
      else if (status.isFile()) files.push(absolute);
      else throw new Error(`unsupported release entry: ${relative(root, absolute)}`);
    }
  }
  await visit(root);
  return files;
}

async function copyTree(sourceRoot, destinationRoot) {
  for (const source of await walkFiles(sourceRoot)) {
    const relativePath = relative(sourceRoot, source);
    const destination = join(destinationRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

async function ensureHostRoot(hostRoot) {
  const root = resolve(hostRoot);
  await mkdir(root, { recursive: true });
  await requireRealDirectory(root, "host root");
  await mkdir(join(root, "releases"), { recursive: true });
  await requireRealDirectory(join(root, "releases"), "release root");
  return root;
}

async function manifestDigest(releaseRoot) {
  return sha256(await readFile(join(releaseRoot, "release-manifest.json")));
}

async function readPointer(root, { required = true } = {}) {
  const pointerPath = join(root, POINTER_NAME);
  let parsed;
  try {
    const status = await lstat(pointerPath);
    if (!status.isFile() || status.isSymbolicLink()) throw new Error("current-release pointer must be a regular file");
    parsed = JSON.parse(await readFile(pointerPath, "utf8"));
  } catch (error) {
    if (!required && error.code === "ENOENT") return null;
    throw error;
  }
  if (parsed.schema !== POINTER_SCHEMA || !Number.isSafeInteger(parsed.generation) || parsed.generation < 1) {
    throw new Error("current-release pointer has an invalid schema or generation");
  }
  assertReleaseId(parsed.releaseId);
  if (parsed.previousReleaseId !== null) assertReleaseId(parsed.previousReleaseId);
  if (!SHA256_PATTERN.test(parsed.releaseManifestSha256)) {
    throw new Error("current-release pointer has an invalid manifest digest");
  }
  return parsed;
}

async function verifyInstalled(root, releaseId) {
  assertReleaseId(releaseId);
  const releaseRoot = resolve(root, "releases", releaseId);
  assertContained(root, releaseRoot, "installed release");
  const result = await verifyRelease(releaseRoot);
  if (result.releaseId !== releaseId) throw new Error("installed release identity mismatch");
  return { ...result, releaseRoot, manifestSha256: await manifestDigest(releaseRoot) };
}

async function writePointer(root, pointer) {
  const pointerPath = join(root, POINTER_NAME);
  const temporaryPath = join(root, `.${POINTER_NAME}.staging-${process.pid}`);
  const bytes = Buffer.from(json(pointer));
  await rm(temporaryPath, { force: true });
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, pointerPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return pointer;
}

export async function installRelease({ releaseDir, hostRoot }) {
  const started = performance.now();
  const sourceRoot = resolve(releaseDir);
  const verified = await verifyRelease(sourceRoot);
  const root = await ensureHostRoot(hostRoot);
  const target = resolve(root, "releases", verified.releaseId);
  assertContained(root, target, "release destination");
  try {
    await lstat(target);
    throw new Error(`installed release already exists: ${verified.releaseId}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stagingParent = resolve(root, `.install-${verified.releaseId}-${process.pid}`);
  const stagingRelease = join(stagingParent, verified.releaseId);
  assertContained(root, stagingParent, "release staging directory");
  await rm(stagingParent, { recursive: true, force: true });
  await mkdir(stagingRelease, { recursive: true });
  try {
    await copyTree(sourceRoot, stagingRelease);
    const staged = await verifyRelease(stagingRelease);
    if (staged.sourceSha !== verified.sourceSha || staged.fileCount !== verified.fileCount) {
      throw new Error("staged release identity drifted during install");
    }
    await rename(stagingRelease, target);
    await rm(stagingParent, { recursive: true, force: true });
  } catch (error) {
    await rm(stagingParent, { recursive: true, force: true });
    throw error;
  }
  const installed = await verifyInstalled(root, verified.releaseId);
  return {
    operation: "install",
    releaseId: verified.releaseId,
    sourceSha: verified.sourceSha,
    fileCount: verified.fileCount,
    releaseManifestSha256: installed.manifestSha256,
    elapsedMs: Math.round(performance.now() - started),
  };
}

export async function activateRelease({ hostRoot, releaseId }) {
  const started = performance.now();
  const root = await ensureHostRoot(hostRoot);
  const installed = await verifyInstalled(root, releaseId);
  const current = await readPointer(root, { required: false });
  if (current?.releaseId === releaseId && current.releaseManifestSha256 === installed.manifestSha256) {
    return { operation: "activate", changed: false, ...current, elapsedMs: Math.round(performance.now() - started) };
  }
  const pointer = {
    schema: POINTER_SCHEMA,
    generation: (current?.generation ?? 0) + 1,
    releaseId,
    releasePath: `/releases/${releaseId}/`,
    releaseManifestSha256: installed.manifestSha256,
    previousReleaseId: current?.releaseId ?? null,
  };
  await writePointer(root, pointer);
  return { operation: "activate", changed: true, ...pointer, elapsedMs: Math.round(performance.now() - started) };
}

export async function rollbackRelease({ hostRoot }) {
  const started = performance.now();
  const root = await ensureHostRoot(hostRoot);
  const current = await readPointer(root);
  if (current.previousReleaseId === null) throw new Error("current release has no verified rollback target");
  const installed = await verifyInstalled(root, current.previousReleaseId);
  const pointer = {
    schema: POINTER_SCHEMA,
    generation: current.generation + 1,
    releaseId: current.previousReleaseId,
    releasePath: `/releases/${current.previousReleaseId}/`,
    releaseManifestSha256: installed.manifestSha256,
    previousReleaseId: current.releaseId,
  };
  await writePointer(root, pointer);
  return { operation: "rollback", changed: true, ...pointer, elapsedMs: Math.round(performance.now() - started) };
}

export async function inspectHost({ hostRoot }) {
  const root = await ensureHostRoot(hostRoot);
  const pointer = await readPointer(root);
  const installed = await verifyInstalled(root, pointer.releaseId);
  if (installed.manifestSha256 !== pointer.releaseManifestSha256) {
    throw new Error("current-release pointer digest does not match the installed release");
  }
  return { operation: "inspect", ...pointer, sourceSha: installed.sourceSha, fileCount: installed.fileCount };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${flag ?? "end"}`);
    values.set(flag.slice(2), value);
  }
  return { command, values };
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  const hostRoot = values.get("host-root");
  if (!hostRoot) throw new Error("missing --host-root");
  let result;
  if (command === "install") {
    if (!values.get("release")) throw new Error("missing --release");
    result = await installRelease({ releaseDir: values.get("release"), hostRoot });
  } else if (command === "activate") {
    if (!values.get("release-id")) throw new Error("missing --release-id");
    result = await activateRelease({ hostRoot, releaseId: values.get("release-id") });
  } else if (command === "rollback") result = await rollbackRelease({ hostRoot });
  else if (command === "inspect") result = await inspectHost({ hostRoot });
  else throw new Error("usage: install --release <dir> --host-root <dir> | activate --release-id <id> --host-root <dir> | rollback --host-root <dir> | inspect --host-root <dir>");
  console.log(json(result).trimEnd());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`self-hosted operations: ${error.message}`);
    process.exitCode = 1;
  });
}
