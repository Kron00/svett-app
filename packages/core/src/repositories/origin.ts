import { Effect } from "effect";

import { Ids, importedId, type Uuid } from "../ids.ts";
import type { Fingerprint, ImportBatchId, SourceIdentity } from "../schema.ts";

/** Where a new row comes from. It decides both the row's provenance columns and its ID. */
export type Origin =
  | { readonly source: "svett" }
  | {
      readonly source: "hevy" | "apple_health";
      readonly sourceId: SourceIdentity;
      readonly fingerprint: Fingerprint;
      readonly importBatchId: ImportBatchId;
    };

export const MADE_HERE: Origin = { source: "svett" };

export const provenance = (origin: Origin) =>
  origin.source === "svett"
    ? { source: origin.source, sourceId: null, fingerprint: null, importBatchId: null }
    : {
        source: origin.source,
        sourceId: origin.sourceId,
        fingerprint: origin.fingerprint,
        importBatchId: origin.importBatchId,
      };

/**
 * A row made here gets a random UUIDv7. An imported row and each of its children get a
 * UUIDv5 of the table, the source and the source identity, extended by the child's `path`
 * inside it, so the same import on two devices makes the same rows.
 */
export const rowId = (
  table: { readonly name: string },
  origin: Origin,
  path = "",
): Effect.Effect<Uuid, never, Ids> =>
  origin.source === "svett"
    ? Effect.flatMap(Effect.service(Ids), (ids) => ids.random)
    : Effect.succeed(importedId(table.name, origin.source, `${origin.sourceId}${path}`));
