import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DeletionLedger } from "./deletion-ledger.ts";

/** A deletion ledger in a new empty directory, for a server that has deleted no account. */
export const withoutDeletions = () =>
  DeletionLedger.layer(mkdtempSync(join(tmpdir(), "svett-ledger-")));

/** Runs test-ledger-writer.ts with `args`, and gives back its exit code and output. */
export const writer = (args: ReadonlyArray<string>) =>
  new Promise<{ readonly code: number | null; readonly output: string }>((resolve, reject) => {
    const script = fileURLToPath(new URL("./test-ledger-writer.ts", import.meta.url));
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
