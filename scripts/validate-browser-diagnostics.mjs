#!/usr/bin/env node
import { open } from "node:fs/promises";
import { summarizeDiagnosticBundle } from "../sdk/engine/support-diagnostics.mjs";

const MAX_BYTES = 128 * 1024;

async function readBounded(path) {
  const handle = await open(path, "r");
  const bytes = Buffer.allocUnsafe(MAX_BYTES + 1);
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (offset > MAX_BYTES) throw new RangeError("Diagnostic bundle exceeds the size limit");
  return bytes.toString("utf8", 0, offset);
}

if (process.argv.length !== 3) {
  console.error("usage: node scripts/validate-browser-diagnostics.mjs <patchy-diagnostics.json>");
  process.exitCode = 2;
} else {
  try {
    const summary = summarizeDiagnosticBundle(await readBounded(process.argv[2]));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    console.error("REJECTED: diagnostic bundle did not satisfy the bounded schema");
    process.exitCode = 1;
  }
}
