import { spawn } from "node:child_process";
import { open } from "node:fs/promises";

import { Context, Data, Effect, Layer, Redacted } from "effect";

export class PgToolError extends Data.TaggedError("PgToolError")<{
  readonly tool: string;
  readonly message: string;
}> {}

/** How to start each PostgreSQL client tool. Production runs the binaries on the PATH. */
export interface PgToolCommands {
  readonly pgDump: ReadonlyArray<string>;
  readonly pgRestore: ReadonlyArray<string>;
}

export interface PgToolsService {
  /** Writes a custom-format dump of the database at `url` to `file`. */
  readonly dump: (url: Redacted.Redacted, file: string) => Effect.Effect<void, PgToolError>;
  /** Loads the dump in `file` into the database at `url` in one transaction. */
  readonly restore: (url: Redacted.Redacted, file: string) => Effect.Effect<void, PgToolError>;
}

export class PgTools extends Context.Service<PgTools, PgToolsService>()("svett/server/PgTools") {
  static readonly layer = (
    commands: PgToolCommands = { pgDump: ["pg_dump"], pgRestore: ["pg_restore"] },
  ): Layer.Layer<PgTools> =>
    Layer.succeed(
      PgTools,
      PgTools.of({
        dump: (url, file) =>
          run(commands.pgDump, ["--format=custom", "--no-owner", "--no-privileges"], url, {
            stdout: file,
          }),
        restore: (url, file) =>
          run(
            commands.pgRestore,
            ["--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction"],
            url,
            { stdin: file },
          ),
      }),
    );
}

/**
 * The tools get the address without its password on the command line, where any
 * process could read it, and the password in PGPASSWORD.
 */
export const connectionFor = (
  url: Redacted.Redacted,
): { readonly dbname: string; readonly password: string | undefined } => {
  const parsed = new URL(Redacted.value(url));
  const password = parsed.password === "" ? undefined : decodeURIComponent(parsed.password);
  parsed.password = "";
  return { dbname: parsed.toString(), password };
};

const run = (
  command: ReadonlyArray<string>,
  args: ReadonlyArray<string>,
  url: Redacted.Redacted,
  io: { readonly stdin?: string; readonly stdout?: string },
): Effect.Effect<void, PgToolError> => {
  const [program, ...prefix] = command;
  const tool = program ?? "";
  const fail = (message: string) => new PgToolError({ tool, message });
  const { dbname, password } = connectionFor(url);
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => ({
        input: io.stdin === undefined ? undefined : await open(io.stdin, "r"),
        output: io.stdout === undefined ? undefined : await open(io.stdout, "wx"),
      }),
      catch: (cause) => fail(`could not open its file: ${String(cause)}`),
    }),
    ({ input, output }) =>
      Effect.callback<void, PgToolError>((resume) => {
        const child = spawn(tool, [...prefix, ...args, `--dbname=${dbname}`], {
          env: { ...process.env, PGPASSWORD: password ?? process.env.PGPASSWORD },
          stdio: [input?.fd ?? "ignore", output?.fd ?? "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-4000);
        });
        child.on("error", (cause) => resume(Effect.fail(fail(cause.message))));
        child.on("close", (code, signal) =>
          resume(
            code === 0
              ? Effect.void
              : Effect.fail(fail(`exited with ${signal ?? code}: ${stderr.trim()}`)),
          ),
        );
        return Effect.sync(() => child.kill("SIGTERM"));
      }),
    ({ input, output }) =>
      Effect.promise(async () => {
        await input?.close();
        await output?.close();
      }),
  );
};
