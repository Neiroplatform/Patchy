import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRelease } from "../../scripts/release/build-self-hosted-release.mjs";
import {
  activateRelease,
  inspectHost,
  installRelease,
  rollbackRelease,
} from "../../scripts/release/manage-self-hosted-release.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

async function createSite(root, marker) {
  const site = join(root, `site-${marker}`);
  const engine = join(site, "engine");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(engine, { recursive: true }));
  const files = new Map([
    [".htaccess", "Header always set Cross-Origin-Opener-Policy same-origin\n"],
    ["capabilities.css", "body{color:white}"],
    ["capabilities.html", "<!doctype html><main>ready</main>"],
    ["capabilities.mjs", "export const ready=true;"],
    ["editor.css", "body{background:black}"],
    ["editor.mjs", `export const marker=${JSON.stringify(marker)};`],
    ["patchy-engine.mjs", "export default async()=>({});"],
    ["patchy-engine.wasm", Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])],
    ["patchy.html", "<!doctype html><main>Patchy</main>"],
    ["engine/client.mjs", "export class Client{}"],
    ["engine/index.mjs", "export const version=1;"],
    ["engine/protocol.mjs", "export const protocol=1;"],
    ["engine/worker.mjs", "self.onmessage=()=>{};"],
  ]);
  for (const [name, contents] of files) await writeFile(join(site, name), contents);
  return site;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "patchy-self-hosted-operations-"));
  const firstId = "r1-first";
  const secondId = "r2-second";
  await buildRelease({
    siteDir: await createSite(root, "first"),
    outputDir: join(root, "built", firstId),
    releaseId: firstId,
    sourceSha: SHA_A,
  });
  await buildRelease({
    siteDir: await createSite(root, "second"),
    outputDir: join(root, "built", secondId),
    releaseId: secondId,
    sourceSha: SHA_B,
    previousReleaseId: firstId,
  });
  return { root, host: join(root, "host"), firstId, secondId };
}

test("verified releases install, activate and roll back without mutation", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const first = await installRelease({ releaseDir: join(value.root, "built", value.firstId), hostRoot: value.host });
  assert.equal(first.fileCount, 38);
  assert.ok(first.elapsedMs < 600_000);
  const firstActivation = await activateRelease({ hostRoot: value.host, releaseId: value.firstId });
  assert.equal(firstActivation.previousReleaseId, null);
  await installRelease({ releaseDir: join(value.root, "built", value.secondId), hostRoot: value.host });
  const secondActivation = await activateRelease({ hostRoot: value.host, releaseId: value.secondId });
  assert.equal(secondActivation.previousReleaseId, value.firstId);
  assert.equal((await inspectHost({ hostRoot: value.host })).sourceSha, SHA_B);
  const rolledBack = await rollbackRelease({ hostRoot: value.host });
  assert.equal(rolledBack.releaseId, value.firstId);
  assert.equal(rolledBack.previousReleaseId, value.secondId);
  assert.equal(rolledBack.generation, 3);
  assert.equal((await inspectHost({ hostRoot: value.host })).sourceSha, SHA_A);
  assert.match(await readFile(join(value.host, "releases", value.firstId, ".htaccess"), "utf8"), /Cross-Origin/);
});

test("install never overwrites an immutable release", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const releaseDir = join(value.root, "built", value.firstId);
  await installRelease({ releaseDir, hostRoot: value.host });
  await assert.rejects(installRelease({ releaseDir, hostRoot: value.host }), /already exists/);
});

test("activation rejects a tampered installed release", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await installRelease({ releaseDir: join(value.root, "built", value.firstId), hostRoot: value.host });
  await writeFile(join(value.host, "releases", value.firstId, "editor.mjs"), "tampered");
  await assert.rejects(activateRelease({ hostRoot: value.host, releaseId: value.firstId }), /integrity verification/);
});

test("rollback fails closed without a previous verified release", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await installRelease({ releaseDir: join(value.root, "built", value.firstId), hostRoot: value.host });
  await activateRelease({ hostRoot: value.host, releaseId: value.firstId });
  await assert.rejects(rollbackRelease({ hostRoot: value.host }), /no verified rollback target/);
});
