const PATTERN = /^svett-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/;

/** The name of a server database backup taken at `epochMillis`, in UTC to the second. */
export const backupFileName = (epochMillis: number): string => {
  const compact = new Date(epochMillis)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `svett-${compact}.dump`;
};

/** When the backup named `name` was taken, or undefined for any other file. */
export const backupTakenAt = (name: string): number | undefined => {
  const match = PATTERN.exec(name);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second] = match.map(Number) as Array<number>;
  const at = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  return backupFileName(at) === name ? at : undefined;
};

/** Backup names, newest first. Files that are not backups are left out. */
export const newestBackupsFirst = (names: ReadonlyArray<string>): Array<string> =>
  names
    .flatMap((name) => {
      const at = backupTakenAt(name);
      return at === undefined ? [] : [{ name, at }];
    })
    .toSorted((a, b) => b.at - a.at)
    .map(({ name }) => name);

/** The backups to delete so only the newest `keep` remain. Other files are never listed. */
export const backupsToPrune = (names: ReadonlyArray<string>, keep: number): Array<string> =>
  newestBackupsFirst(names).slice(Math.max(1, keep));
