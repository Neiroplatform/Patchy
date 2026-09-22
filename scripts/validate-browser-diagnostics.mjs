#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { summarizeDiagnosticBundle } from "../sdk/engine/support-diagnostics.mjs";

if (process.argv.length !== 3) {
  console.error("usage: node scripts/validate-browser-diagnostics.mjs <patchy-diagnostics.json>");
  process.exitCode = 2;
} else {
  try {
    const bytes = await readFile(process.argv[2]);
    if (bytes.byteLength > 128 * 1024) throw new RangeError("Diagnostic bundle exceeds the size limit");
    const summary = summarizeDiagnosticBundle(bytes.toString("utf8"));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    console.error(`REJECTED: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
