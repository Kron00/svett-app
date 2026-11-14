import { describe, expect, it } from "vite-plus/test";

import {
  backupFileName,
  backupsToPrune,
  backupTakenAt,
  newestBackupsFirst,
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
