import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { backupFileName, backupsToPrune, backupTakenAt, newestBackupsFirst } from "@svett/core";
import {
  Clock,
  Context,
  Cron,
  Data,
  Effect,
  Layer,
  Ref,
  Result,
  Schedule,
  Semaphore,
} from "effect";

import { ServerConfig } from "./config.ts";
import { PgTools, type PgToolError } from "./pg-tools.ts";
import { checkRestore } from "./restore.ts";

export class BackupError extends Data.TaggedError("BackupError")<{
  readonly message: string;
}> {}

export interface LatestBackup {
  readonly file: string;
  readonly takenAt: number;
}

export interface RestoreCheck {
  readonly backupTakenAt: number;
  readonly checkedAt: number;
  /** How many tables the restore brought back, or undefined when it failed. */
  readonly tables: number | undefined;
}

export interface BackupsService {
  /** Dumps the database to a new file, then deletes backups past the kept number. */
  readonly takeNow: Effect.Effect<LatestBackup, BackupError | PgToolError>;
  /** The newest finished backup, if there is one. */
  readonly latest: Effect.Effect<LatestBackup | undefined, BackupError>;
  /**
   * Restores `backup` into a scratch database on the live server, then drops it.
   * A failed restore is reported in the result, not as an error.
   */
  readonly checkRestore: (backup: LatestBackup) => Effect.Effect<RestoreCheck>;
  /** The result of the newest restore check since the server started. */
  readonly lastRestoreCheck: Effect.Effect<RestoreCheck | undefined>;
}

const DAY_MILLIS = 24 * 60 * 60 * 1000;

const fs = <A>(message: string, use: () => Promise<A>) =>
  Effect.tryPromise({
    try: use,
    catch: (cause) => new BackupError({ message: `${message}: ${String(cause)}` }),
  });

export class Backups extends Context.Service<Backups, BackupsService>()("svett/server/Backups") {
  static readonly layer: Layer.Layer<Backups, never, ServerConfig | PgTools> = Layer.effect(
    Backups,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const tools = yield* PgTools;
      const lock = yield* Semaphore.make(1);
      const dir = config.backupDir;

      const list = fs(`could not read ${dir}`, async () => {
        await mkdir(dir, { recursive: true });
        return readdir(dir);
      });

      const latest = Effect.map(list, (names) => {
        const [newest] = newestBackupsFirst(names);
        return newest === undefined
          ? undefined
          : { file: join(dir, newest), takenAt: backupTakenAt(newest)! };
      });

      const takeNow = lock.withPermits(1)(
        Effect.gen(function* () {
          yield* list;
          const now = yield* Clock.currentTimeMillis;
          const name = backupFileName(now);
          const file = join(dir, name);
          // Only a complete dump gets a backup's name, so a crash mid-dump never
          // leaves a file that looks restorable.
          const partial = `${file}.partial`;
          yield* tools
            .dump(config.databaseUrl, partial)
            .pipe(Effect.onError(() => Effect.promise(() => rm(partial, { force: true }))));
          yield* fs(`could not finish ${name}`, () => rename(partial, file));
          const stale = backupsToPrune(yield* list, config.backupKeep);
          yield* Effect.forEach(stale, (old) =>
            fs(`could not delete ${old}`, () => rm(join(dir, old), { force: true })),
          );
          return { file, takenAt: backupTakenAt(name)! };
        }),
      );

      const lastCheck = yield* Ref.make<RestoreCheck | undefined>(undefined);

      const restoreCheck = (backup: LatestBackup) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const tables = yield* checkRestore(backup.file, config.databaseUrl).pipe(
              Effect.provideService(PgTools, tools),
              Effect.tapCause((cause) => Effect.logError("Restore check failed", cause)),
              Effect.orElseSucceed(() => undefined),
            );
            const result = {
              backupTakenAt: backup.takenAt,
              checkedAt: yield* Clock.currentTimeMillis,
              tables,
            };
            yield* Ref.set(lastCheck, result);
            return result;
          }),
        );

      return Backups.of({
        takeNow,
        latest,
        checkRestore: restoreCheck,
        lastRestoreCheck: Ref.get(lastCheck),
      });
    }),
  );
}

/**
 * Takes a backup at every tick of the configured cron schedule, in UTC, and proves
 * each one restores. On start it takes one at once when the newest is more than a
 * day old, so a server that was down overnight does not skip a day, and checks the
 * newest backup restores.
 */
export const NightlyBackups: Layer.Layer<never, BackupError, Backups | ServerConfig> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const backups = yield* Backups;
      const config = yield* ServerConfig;
      const cron = Cron.parse(config.backupCron, "UTC");
      if (Result.isFailure(cron)) {
        return yield* new BackupError({
          message: `BACKUP_CRON is not valid: ${config.backupCron}`,
        });
      }

      const check = (backup: LatestBackup) =>
        Effect.flatMap(backups.checkRestore(backup), ({ tables }) =>
          tables === undefined
            ? Effect.void
            : Effect.logInfo(`Restore check of ${backup.file} brought back ${tables} tables`),
        );

      const takeOne = backups.takeNow.pipe(
        Effect.tap(({ file }) => Effect.logInfo(`Backup written to ${file}`)),
        Effect.flatMap(check),
        Effect.catchCause((cause) => Effect.logError("Backup failed", cause)),
      );

      const catchUp = Effect.gen(function* () {
        const newest = yield* backups.latest;
        const now = yield* Clock.currentTimeMillis;
        if (newest === undefined || now - newest.takenAt > DAY_MILLIS) yield* takeOne;
        else yield* check(newest);
      }).pipe(Effect.catchCause((cause) => Effect.logError("Backup failed", cause)));

      yield* Effect.forkScoped(
        Effect.andThen(catchUp, Effect.schedule(takeOne, Schedule.cron(cron.success))),
      );
    }),
  );
