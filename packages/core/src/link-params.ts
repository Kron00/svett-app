import { Schema } from "effect";

/** A link's query as a record, whatever the router handed over. */
export const linkParams = (params: unknown): Readonly<Record<string, unknown>> =>
  typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};

/** One link param if it fits the schema, or null, so an unknown value drops only itself. */
export const linkParam = <S extends Schema.Top>(schema: S, value: unknown): S["Type"] | null =>
  Schema.is(schema)(value) ? value : null;
