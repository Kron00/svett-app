import { Config, Context, Effect, Layer, Redacted } from "effect";

export interface ServerConfigShape {
  readonly port: number;
  readonly databaseUrl: Redacted.Redacted;
  /** The directory the nightly backups go to. It must outlive the container. */
  readonly backupDir: string;
  /** How many backups to keep. Older ones are deleted after each new one. */
  readonly backupKeep: number;
  /** When the nightly backup runs, as a cron expression in UTC. */
  readonly backupCron: string;
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "svett/server/ServerConfig",
) {
  static readonly fromEnv: Layer.Layer<ServerConfig, Config.ConfigError> = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      return ServerConfig.of({
        port: yield* Config.Port("PORT").pipe(Config.withDefault(3000)),
        databaseUrl: yield* Config.Redacted("DATABASE_URL"),
        backupDir: yield* Config.String("BACKUP_DIR").pipe(Config.withDefault("/backups")),
        backupKeep: yield* Config.Int("BACKUP_KEEP").pipe(Config.withDefault(14)),
        backupCron: yield* Config.String("BACKUP_CRON").pipe(Config.withDefault("0 3 * * *")),
      });
    }),
  );
}
