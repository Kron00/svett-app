import { Data, Exit, Schema } from "effect";

import { EpochMillis } from "./schema.ts";
import { TABLES } from "./table.ts";
import { type AnyRow, type Snapshot, TABLE_KEYS, type TableRows } from "./transfer.ts";

/** Raised by every change to the file's shape. An older svett refuses a newer file. */
export const SVETT_FILE_VERSION = 1;

export interface SvettFile {
  readonly version: number;
  readonly exportedAt: EpochMillis;
  /** Live rows by table, each parsed by its table's schema. */
  readonly tables: TableRows;
  /** How many rows the file holds. */
  readonly rows: number;
}

export class SvettFileError extends Data.TaggedError("SvettFileError")<{
  readonly reason: "not_svett" | "too_new" | "invalid";
  readonly message: string;
}> {}

const Envelope = Schema.Struct({
  format: Schema.Literal("svett"),
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  exportedAt: EpochMillis,
  tables: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)),
});

/**
 * Writes every live row of every table as one JSON file. Rows keep their IDs and their
 * fields as the app reads them, so the file is readable on its own.
 */
export const encodeSvettFile = (snapshot: Snapshot, exportedAt: EpochMillis): string =>
  JSON.stringify({
    format: "svett",
    version: SVETT_FILE_VERSION,
    exportedAt,
    tables: Object.fromEntries(
      TABLE_KEYS.map((key) => [TABLES[key].name, snapshot[key].filter((row) => !row.deletedAt)]),
    ),
  });

export const exportFileName = (exportedAt: EpochMillis): string =>
  `svett-export-${new Date(exportedAt).toISOString().slice(0, 10)}.json`;

const notSvett = new SvettFileError({
  reason: "not_svett",
  message: "This is not a svett export file.",
});

/**
 * Reads a svett file. Every row passes its table's schema, so a damaged or edited file is
 * refused whole rather than half imported. Rows marked deleted are left out.
 */
export const decodeSvettFile = (text: string): Exit.Exit<SvettFile, SvettFileError> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return Exit.fail(notSvett);
  }
  const envelope = Schema.decodeUnknownExit(Envelope)(json);
  if (Exit.isFailure(envelope)) return Exit.fail(notSvett);
  const { version, exportedAt, tables } = envelope.value;
  if (version > SVETT_FILE_VERSION) {
    return Exit.fail(
      new SvettFileError({
        reason: "too_new",
        message: "A newer svett made this file. Update svett, then import it again.",
      }),
    );
  }
  const known = new Set(TABLE_KEYS.map((key) => TABLES[key].name));
  const unknown = Object.keys(tables).find((name) => !known.has(name));
  if (unknown !== undefined) {
    return Exit.fail(
      new SvettFileError({
        reason: "invalid",
        message: `The file has a table svett does not know, ${unknown}.`,
      }),
    );
  }

  const parsed: Partial<Record<(typeof TABLE_KEYS)[number], Array<AnyRow>>> = {};
  let rows = 0;
  for (const key of TABLE_KEYS) {
    const name = TABLES[key].name;
    const decode = Schema.decodeUnknownExit(Schema.toType(TABLES[key].schema));
    const seen = new Set<string>();
    const live: Array<AnyRow> = [];
    for (const [index, raw] of (tables[name] ?? []).entries()) {
      const row = decode(raw);
      if (Exit.isFailure(row)) {
        return Exit.fail(
          new SvettFileError({
            reason: "invalid",
            message: `Row ${index + 1} of ${name} is not valid.`,
          }),
        );
      }
      const value = row.value as AnyRow;
      if (seen.has(value.id)) {
        return Exit.fail(
          new SvettFileError({
            reason: "invalid",
            message: `The file holds ${name} row ${value.id} twice.`,
          }),
        );
      }
      seen.add(value.id);
      if (value.deletedAt === null) live.push(value);
    }
    parsed[key] = live;
    rows += live.length;
  }
  return Exit.succeed({ version, exportedAt, tables: parsed, rows });
};
