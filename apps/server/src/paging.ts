import { Data, Effect, Schema } from "effect";

/** A cursor svett did not make, or one whose item the viewer may no longer see. */
export class InvalidCursor extends Data.TaggedError("InvalidCursor")<{}> {}

export const encodeCursor = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export const decodeCursor =
  <A>(schema: Schema.Codec<A, unknown>) =>
  (cursor: string) =>
    Effect.try({
      try: () => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown,
      catch: () => new InvalidCursor(),
    }).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => new InvalidCursor())),
      ),
    );

// A post cursor names the last post by its social ID alone, so no time leaves the server in it.
const PostCursor = Schema.Struct({ id: Schema.String });

/** The social ID a post cursor names. */
export const readPostCursor = (cursor: string) =>
  Effect.map(decodeCursor(PostCursor)(cursor), ({ id }) => id);

export const postCursor = (socialId: string) => encodeCursor({ id: socialId });

/** Where a post sits in a list ordered by when it was shared, newest first. */
export type SharedAnchor = { readonly sharedMs: string; readonly socialId: string };

/** Rows read at a time while skipping ones the viewer may not see. */
export const SCAN = 100;

/**
 * The first `want` rows that `toItem` turns into an item, each with its item. `fetch` reads up
 * to SCAN rows in order after the row it is given, so rows the viewer may not see never
 * shorten a page or end it early.
 */
export const firstVisible = <Row, Item, E>(
  fetch: (after: Row | undefined) => Effect.Effect<ReadonlyArray<Row>, E>,
  toItem: (row: Row) => Item | undefined,
  want: number,
) =>
  Effect.gen(function* () {
    const kept: Array<{ readonly row: Row; readonly item: Item }> = [];
    let after: Row | undefined;
    while (true) {
      const rows = yield* fetch(after);
      for (const row of rows) {
        const item = toItem(row);
        if (item !== undefined) kept.push({ row, item });
        if (kept.length === want) return kept;
      }
      if (rows.length < SCAN) return kept;
      after = rows.at(-1);
    }
  });
