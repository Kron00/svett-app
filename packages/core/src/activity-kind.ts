import { Schema } from "effect";

export const ActivityKind = Schema.Literals(["strength", "run", "ride", "walk", "hike", "other"]);

export type ActivityKind = typeof ActivityKind.Type;
