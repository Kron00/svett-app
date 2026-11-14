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
    .sort((a, b) => b.at - a.at)
    .map(({ name }) => name);

/** The backups to delete so only the newest `keep` remain. Other files are never listed. */
export const backupsToPrune = (names: ReadonlyArray<string>, keep: number): Array<string> =>
  newestBackupsFirst(names).slice(Math.max(1, keep));

const SCRATCH_PATTERN = /^svett_restore_([0-9a-f]{8})_(\d{13})_[0-9a-f]{12}$/;
const SCRATCH_STALE_MILLIS = 24 * 60 * 60 * 1000;

/**
 * The scratch database a restore check of the live database tagged `tag` creates at
 * `epochMillis`. `tag` is 8 hex digits that stand for the live database, so each live
 * database only ever sweeps its own. `suffix` is 12 random hex digits, so checks that
 * start together on other servers never share one.
 */
export const restoreScratchName = (tag: string, epochMillis: number, suffix: string): string =>
  `svett_restore_${tag}_${String(epochMillis).padStart(13, "0")}_${suffix}`;

/**
 * The scratch databases of the live database tagged `tag` created more than a day
 * before `now`. A check that crashed left them behind. Younger ones may belong to a
 * check still running.
 */
export const staleRestoreScratches = (
  names: ReadonlyArray<string>,
  tag: string,
  now: number,
): Array<string> =>
  names.filter((name) => {
    const match = SCRATCH_PATTERN.exec(name);
    return match !== null && match[1] === tag && now - Number(match[2]) > SCRATCH_STALE_MILLIS;
  });
