import { Data, Exit, Result, Schema } from "effect";

import { EpochMillis, type ImportChange } from "./schema.ts";
import { TABLES } from "./table.ts";
import {
  type AnyRow,
  journalProblem,
  type Snapshot,
  TABLE_KEYS,
  type TableRows,
  withAddedFields,
} from "./transfer.ts";

/**
 * Raised by every change to the file's shape. An older svett refuses a newer file. Version 2
 * added a workout's status and routine and a set's done mark and target, which a version 1
 * file reads with the values its rows had then.
 */
export const SVETT_FILE_VERSION = 2;

export interface SvettFile {
  readonly version: number;
  readonly exportedAt: EpochMillis;
  /** Rows by table, deleted ones too, each parsed by its table's schema. */
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
 * Writes every row of every table as one JSON file. Rows keep their IDs and their fields as
 * the app reads them, so the file is readable on its own. Deleted rows go too, so a deletion
 * survives an export and import, even of a library exercise that every install seeds.
 */
export const encodeSvettFile = (snapshot: Snapshot, exportedAt: EpochMillis): string =>
  JSON.stringify({
    format: "svett",
    version: SVETT_FILE_VERSION,
    exportedAt,
    tables: Object.fromEntries(TABLE_KEYS.map((key) => [TABLES[key].name, snapshot[key]])),
  });

export const exportFileName = (exportedAt: EpochMillis): string =>
  `svett-export-${new Date(exportedAt).toISOString().slice(0, 10)}.json`;

const notSvett = new SvettFileError({
  reason: "not_svett",
  message: "This is not a svett export file.",
});

/**
 * Reads a svett file. Every row passes its table's schema, and every import change's journal
 * passes the schemas of the tables it names, so a damaged or edited file is refused whole
 * rather than half imported.
 */
export const decodeSvettFile = (text: string): Result.Result<SvettFile, SvettFileError> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return Result.fail(notSvett);
  }
  const envelope = Schema.decodeUnknownExit(Envelope)(json);
  if (Exit.isFailure(envelope)) return Result.fail(notSvett);
  const { version, exportedAt, tables } = envelope.value;
  if (version > SVETT_FILE_VERSION) {
    return Result.fail(
      new SvettFileError({
        reason: "too_new",
        message: "A newer svett made this file. Update svett, then import it again.",
      }),
    );
  }
  const known = new Set(TABLE_KEYS.map((key) => TABLES[key].name));
  const unknown = Object.keys(tables).find((name) => !known.has(name));
  if (unknown !== undefined) {
    return Result.fail(
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
    const kept: Array<AnyRow> = [];
    for (const [index, raw] of (tables[name] ?? []).entries()) {
      const row = decode(withAddedFields(key, raw));
      if (Exit.isFailure(row)) {
        return Result.fail(
          new SvettFileError({
            reason: "invalid",
            message: `Row ${index + 1} of ${name} is not valid.`,
          }),
        );
      }
      const value = row.value as AnyRow;
      if (seen.has(value.id)) {
        return Result.fail(
          new SvettFileError({
            reason: "invalid",
            message: `The file holds ${name} row ${value.id} twice.`,
          }),
        );
      }
      const problem =
        key === "importChange" ? journalProblem(value as unknown as ImportChange) : undefined;
      if (problem !== undefined) {
        return Result.fail(
          new SvettFileError({
            reason: "invalid",
            message: `Row ${index + 1} of ${name} is not valid, because ${problem}.`,
          }),
        );
      }
      seen.add(value.id);
      kept.push(value);
    }
    parsed[key] = kept;
    rows += kept.length;
  }
  return Result.succeed({ version, exportedAt, tables: parsed, rows });
};
