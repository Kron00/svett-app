import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { backupFileName, backupsToPrune, backupTakenAt, newestBackupsFirst } from "@svett/core";
import { Clock, Context, Cron, Data, Effect, Layer, Result, Schedule, Semaphore } from "effect";

import { ServerConfig } from "./config.ts";
import { PgTools, type PgToolError } from "./pg-tools.ts";

export class BackupError extends Data.TaggedError("BackupError")<{
  readonly message: string;
}> {}

export interface LatestBackup {
  readonly file: string;
  readonly takenAt: number;
}

export interface BackupsService {
  /** Dumps the database to a new file, then deletes backups past the kept number. */
  readonly takeNow: Effect.Effect<LatestBackup, BackupError | PgToolError>;
  /** The newest finished backup, if there is one. */
  readonly latest: Effect.Effect<LatestBackup | undefined, BackupError>;
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

      return Backups.of({ takeNow, latest });
    }),
  );
}

/**
 * Takes a backup at every tick of the configured cron schedule, in UTC. On start it
 * takes one at once when the newest is more than a day old, so a server that was
 * down overnight does not skip a day.
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

      const takeOne = backups.takeNow.pipe(
        Effect.tap(({ file }) => Effect.logInfo(`Backup written to ${file}`)),
        Effect.catchCause((cause) => Effect.logError("Backup failed", cause)),
      );

      const catchUp = Effect.gen(function* () {
        const newest = yield* backups.latest;
        const now = yield* Clock.currentTimeMillis;
        if (newest === undefined || now - newest.takenAt > DAY_MILLIS) yield* takeOne;
      }).pipe(Effect.catchCause((cause) => Effect.logError("Backup check failed", cause)));

      yield* Effect.forkScoped(
        Effect.andThen(catchUp, Effect.schedule(takeOne, Schedule.cron(cron.success))),
      );
    }),
  );
