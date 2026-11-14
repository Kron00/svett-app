import type { Effect } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";

/**
 * The server's schema changes, keyed `<id>_<name>`. Append new ones with the next id.
 * Never edit one that has shipped.
 */
export const MIGRATIONS: Record<string, Effect.Effect<void, unknown, SqlClient>> = {};
