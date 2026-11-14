import { CoachEvent, ConversationId, databaseLayer, Ids } from "@svett/core";
import { buildFixture, manualClock, openNodeDatabase } from "@svett/core/node";
import { Layer, ManagedRuntime, Schema } from "effect";

/**
 * One request the coach sent and what came back: the body svett built, OpenAI's HTTP status and
 * raw stream, and the events Swift turned that stream into. The Swift module writes exchanges in
 * this shape when the app runs with `-svettCoachRecord`, and replays them with `-svettCoachStub`.
 */
export const CoachExchange = Schema.Struct({
  request: Schema.Unknown,
  status: Schema.Number,
  body: Schema.String,
  events: Schema.Array(CoachEvent),
});
export type CoachExchange = typeof CoachExchange.Type;

export const CoachFixture = Schema.Struct({
  /** `stand-in` is built from OpenAI's documented stream events, `live` was recorded from OpenAI. */
  source: Schema.Literals(["stand-in", "live"]),
  recordedAt: Schema.Number,
  exchanges: Schema.Array(CoachExchange),
});
export type CoachFixture = typeof CoachFixture.Type;

export const decodeCoachFixture = Schema.decodeUnknownSync(Schema.fromJsonString(CoachFixture));

export const FIXTURE_CONVERSATION = ConversationId.make("019a0000-0000-7000-8000-000000000001");

const openOn = (driver: ReturnType<typeof openNodeDatabase>["driver"], now: number) => {
  const clock = manualClock(now);
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(databaseLayer(driver, Ids.layerSeeded(7)), clock.layer),
  );
  return { runtime, clock };
};

/**
 * The generated 300-workout database in memory, with every repository, a clock at `now`, and the
 * same seeded IDs each time.
 */
export const openFixtureDatabase = async (now: number) => {
  const { driver } = openNodeDatabase();
  await buildFixture(driver);
  return openOn(driver, now);
};

/** A database in memory with only the exercise library, for tests that add their own rows. */
export const openEmptyDatabase = (now: number) => openOn(openNodeDatabase().driver, now);
