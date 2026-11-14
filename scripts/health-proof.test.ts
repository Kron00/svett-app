import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readFileSync } from "node:fs";

import { bytesSource, readSourceFile, sourceFileSummary } from "@svett/core";
import { Result } from "effect";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  EXPORT_FILE,
  GPX_FILE,
  judge,
  judgePreview,
  MANUAL,
  manualLink,
  PREVIEWS,
  readState,
  seed,
  type Stage,
  writeFiles,
} from "./health-proof.ts";
import { importFile, saveManual } from "./test/health-app.ts";

const script = fileURLToPath(new URL("health-proof.ts", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "svett-health-proof-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const check = (database: string, stage: Stage) => judge(stage, readState(database));

describe("the health proof", () => {
  it("passes each stage in order when svett does what the proof asks", async () => {
    const database = join(directory, "walk.db");
    writeFiles(directory);
    await seed(database);
    expect(check(database, "seeded").ok).toBe(true);
    expect(check(database, "declined").ok).toBe(true);
    await importFile(database, join(directory, EXPORT_FILE));
    expect(check(database, "imported")).toMatchObject({ ok: true });
    await importFile(database, join(directory, EXPORT_FILE));
    expect(check(database, "again").ok).toBe(true);
    await importFile(database, join(directory, GPX_FILE));
    expect(check(database, "gpx").ok).toBe(true);
    await saveManual(database);
    const manual = check(database, "manual");
    expect(manual.lines.filter((line) => line.startsWith("FAILED"))).toEqual([]);
  });

  it("fails a stage the database has not reached, naming what is missing", async () => {
    const database = join(directory, "early.db");
    await seed(database);
    const result = check(database, "imported");
    expect(result.ok).toBe(false);
    expect(result.lines).toContain("FAILED: imported, 4 workouts and 9 sets");
    expect(result.lines).toContain(
      "FAILED: imported, the Hevy workout records Apple Health as a linked source",
    );
  });

  it("exits 1 from the command line when a check fails", async () => {
    const database = join(directory, "cli.db");
    await seed(database);
    expect(
      execFileSync(process.execPath, [script, "check", database, "seeded"], { encoding: "utf8" }),
    ).toContain("PASSED: seeded, 1 workout and 9 sets");
    expect(() =>
      execFileSync(process.execPath, [script, "check", database, "gpx"], { stdio: "pipe" }),
    ).toThrow();
  });

  it("fills manual entry through a svett://manual link", () => {
    const query = new URL(manualLink()).searchParams;
    expect(Object.fromEntries(query)).toEqual({
      kind: MANUAL.kind,
      start: String(MANUAL.start),
      duration: "1:05:00",
      distance: "25.4",
      notes: "Coast loop",
    });
  });

  it("writes an export svett reads whole, but for the one run it holds unreadable on purpose", async () => {
    writeFiles(directory);
    const read = async (name: string) =>
      Result.getOrThrow(
        await readSourceFile(bytesSource(readFileSync(join(directory, name))), {
          hourOf: (at) => new Date(at).getUTCHours(),
        }),
      );
    const exported = await read(EXPORT_FILE);
    expect(exported.workouts.map(({ kind, title }) => `${kind} ${title}`)).toEqual([
      "run Morning run",
      "strength Evening workout",
      "ride Afternoon ride",
      "other Yoga",
    ]);
    expect(exported.skipped).toBe(1);
    expect(sourceFileSummary(exported)).toBe(PREVIEWS[EXPORT_FILE].summary);
    const gpx = await read(GPX_FILE);
    expect(gpx.skipped).toBe(0);
    expect(sourceFileSummary(gpx)).toBe(PREVIEWS[GPX_FILE].summary);
  });

  it("passes a preview only when svett shows the summary the proof expects", () => {
    expect(judgePreview(EXPORT_FILE, `${PREVIEWS[EXPORT_FILE].summary}\n`).ok).toBe(true);
    expect(judgePreview(EXPORT_FILE, "An Apple Health export with 4 workouts.")).toEqual({
      ok: false,
      lines: [
        expect.stringMatching(
          /^FAILED: preview of svett-health-export.zip, .*svett shows "An Apple Health export with 4 workouts."$/,
        ),
      ],
    });
  });
});
