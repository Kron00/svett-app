import { describe, expect, it } from "vite-plus/test";

import {
  backupFileName,
  backupsToPrune,
  backupTakenAt,
  newestBackupsFirst,
  restoreScratchName,
  staleRestoreScratches,
} from "./backup-files.ts";

const at = (iso: string) => Date.parse(iso);

describe("backupFileName", () => {
  it("names a backup by its UTC time to the second", () => {
    expect(backupFileName(at("2026-11-14T03:00:00.789Z"))).toBe("svett-20261114T030000Z.dump");
  });

  it("reads the time back from the name", () => {
    expect(backupTakenAt("svett-20261114T030000Z.dump")).toBe(at("2026-11-14T03:00:00Z"));
  });

  it.each([
    "svett-20261114T030000Z.dump.partial",
    "svett-20261314T030000Z.dump",
    "svett-20261131T030000Z.dump",
    "other-20261114T030000Z.dump",
    "notes.txt",
  ])("does not read %j as a backup", (name) => {
    expect(backupTakenAt(name)).toBeUndefined();
  });
});

describe("backupsToPrune", () => {
  const names = [
    "svett-20261112T030000Z.dump",
    "svett-20261114T030000Z.dump",
    "svett-20261113T030000Z.dump",
    "svett-20261115T030000Z.dump.partial",
    "lost+found",
  ];

  it("lists backups newest first and skips other files", () => {
    expect(newestBackupsFirst(names)).toEqual([
      "svett-20261114T030000Z.dump",
      "svett-20261113T030000Z.dump",
      "svett-20261112T030000Z.dump",
    ]);
  });

  it("deletes all but the newest backups", () => {
    expect(backupsToPrune(names, 2)).toEqual(["svett-20261112T030000Z.dump"]);
  });

  it("deletes nothing while there are no more than the kept number", () => {
    expect(backupsToPrune(names, 3)).toEqual([]);
  });

  it("always keeps the newest backup", () => {
    expect(backupsToPrune(names, 0)).toEqual([
      "svett-20261113T030000Z.dump",
      "svett-20261112T030000Z.dump",
    ]);
  });
});

describe("restore scratch databases", () => {
  const now = at("2026-11-14T03:00:00Z");
  const hour = 60 * 60 * 1000;

  it("names a scratch database by its live database, when it was made and a random suffix", () => {
    expect(restoreScratchName("0a1b2c3d", now, "0123456789ab")).toBe(
      "svett_restore_0a1b2c3d_1794625200000_0123456789ab",
    );
  });

  it("lists only scratch databases of its own live database made more than a day ago", () => {
    const old = restoreScratchName("0a1b2c3d", now - 25 * hour, "aaaaaaaaaaaa");
    const running = restoreScratchName("0a1b2c3d", now - 23 * hour, "bbbbbbbbbbbb");
    const otherLive = restoreScratchName("ffffffff", now - 25 * hour, "cccccccccccc");
    expect(
      staleRestoreScratches(
        [
          old,
          running,
          otherLive,
          "svett",
          "svett_restore_check",
          "svett_restore_1794535200000_aaaaaaaaaaaa",
          "svett_restore_0a1b2c3d_1_aaaaaaaaaaaa",
          "postgres",
        ],
        "0a1b2c3d",
        now,
      ),
    ).toEqual([old]);
  });
});
