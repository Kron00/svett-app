import { Clock, Data, Effect, Semaphore } from "effect";

import { cardioDraft, cardioTitle, summarize } from "./cardio.ts";
import { Ids } from "./ids.ts";
import {
  applyEvent,
  type CardioKind,
  encodeRecordingEvent,
  type Fix,
  isPaused,
  parseJournal,
  type Recording,
  type RecordingEvent,
  replay,
} from "./recording.ts";
import { ActivityRepository } from "./repositories/activities.ts";
import { ActivityId } from "./schema.ts";

/** What the recorder needs from the phone. Each promise rejects when the phone refuses. */
export interface RecorderPorts {
  readonly journal: {
    /** The journal's text, empty when there is none. */
    readonly read: () => string;
    readonly append: (text: string) => Promise<void>;
    readonly remove: () => Promise<void>;
  };
  readonly location: {
    readonly start: () => Promise<void>;
    readonly stop: () => Promise<void>;
  };
  /** The hour of the day at a time, where the phone is, for the activity's title. */
  readonly localHour: (at: number) => number;
  /** Called after every change with the recording as it now is. */
  readonly onChange: (recording: Recording | undefined) => void;
}

export class RecorderError extends Data.TaggedError("RecorderError")<{
  readonly step: "journal" | "location" | "save";
  readonly message: string;
}> {}

export class NoRecordingError extends Data.TaggedError("NoRecordingError")<{}> {}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const attempt = (step: RecorderError["step"], run: () => Promise<void>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RecorderError({ step, message: messageOf(cause) }),
  });

/**
 * Records a run, walk, hike or ride into a journal, and saves it as an activity.
 * One change happens at a time, in the order asked, so every journal write has
 * finished before the next change or the journal's removal. A change the phone
 * refuses leaves the recording as it was and fails with the reason.
 */
export const makeRecorder = (ports: RecorderPorts) => {
  const lock = Semaphore.makeUnsafe(1);
  const serially = lock.withPermits(1);
  let current = (() => {
    try {
      return replay(parseJournal(ports.journal.read()));
    } catch {
      return undefined;
    }
  })();

  const set = (next: Recording | undefined) => {
    current = next;
    ports.onChange(next);
  };

  const write = (events: ReadonlyArray<RecordingEvent>) =>
    Effect.gen(function* () {
      yield* attempt("journal", () =>
        ports.journal.append(events.map((event) => `${encodeRecordingEvent(event)}\n`).join("")),
      );
      set(events.reduce(applyEvent, current));
    });

  // After a failed start the updates may be half on, and nothing would read them.
  const stopQuietly = attempt("location", ports.location.stop).pipe(Effect.ignore);

  const startUpdates = attempt("location", ports.location.start).pipe(
    Effect.tapError(() => stopQuietly),
  );

  const forget = Effect.gen(function* () {
    yield* attempt("journal", ports.journal.remove);
    set(undefined);
  });

  return {
    get: () => current,

    /** Starts a recording, or does nothing while one is in progress. */
    start: (kind: CardioKind) =>
      serially(
        Effect.gen(function* () {
          if (current !== undefined) return;
          const activityId = ActivityId.make(
            yield* Effect.flatMap(Effect.service(Ids), (ids) => ids.random),
          );
          const at = yield* Clock.currentTimeMillis;
          yield* startUpdates;
          yield* write([{ type: "start", at, kind, activityId }]).pipe(
            Effect.tapError(() => stopQuietly),
          );
        }),
      ),

    pause: serially(
      Effect.gen(function* () {
        if (current === undefined || isPaused(current)) return;
        yield* write([{ type: "pause", at: yield* Clock.currentTimeMillis }]);
        yield* attempt("location", ports.location.stop);
      }),
    ),

    /** Resumes once the phone is measuring again. Until then the recording stays paused. */
    resume: serially(
      Effect.gen(function* () {
        if (current === undefined || !isPaused(current)) return;
        const at = yield* Clock.currentTimeMillis;
        yield* startUpdates;
        yield* write([{ type: "resume", at }]).pipe(Effect.tapError(() => stopQuietly));
      }),
    ),

    /** Readings the phone handed over. Readings with no recording to join are dropped. */
    addFixes: (fixes: ReadonlyArray<Fix>) =>
      serially(
        Effect.gen(function* () {
          if (current === undefined || fixes.length === 0) return;
          yield* write(fixes.map((fix) => ({ type: "fix", fix })));
        }),
      ),

    /**
     * Brings the phone in line with the journal when svett opens: measuring while a
     * recording runs, not otherwise. When the phone will not measure, the recording
     * pauses, so it never shows as recording with no GPS.
     */
    restore: serially(
      Effect.gen(function* () {
        if (current === undefined || isPaused(current)) {
          yield* attempt("location", ports.location.stop);
          return;
        }
        yield* startUpdates.pipe(
          Effect.tapError(() =>
            Effect.flatMap(Clock.currentTimeMillis, (at) => write([{ type: "pause", at }])),
          ),
        );
      }),
    ),

    /**
     * Pauses if needed, saves the recording as an activity and removes the journal.
     * The activity is saved under the ID the recording started with, so finishing
     * again after a crash between the save and the removal saves nothing twice.
     */
    finish: serially(
      Effect.gen(function* () {
        if (current === undefined) return yield* new NoRecordingError();
        if (!isPaused(current)) {
          yield* write([{ type: "pause", at: yield* Clock.currentTimeMillis }]);
        }
        yield* attempt("location", ports.location.stop);
        const recording = current;
        const end = recording.segments.at(-1)!.to!;
        const activities = yield* Effect.service(ActivityRepository);
        const id = yield* activities
          .create(
            cardioDraft(
              summarize(recording, end),
              cardioTitle(recording.kind, ports.localHour(recording.startedAt)),
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) => new RecorderError({ step: "save", message: messageOf(cause) }),
            ),
          );
        yield* forget;
        return id;
      }),
    ),

    discard: serially(
      Effect.gen(function* () {
        yield* stopQuietly;
        yield* forget;
      }),
    ),
  };
};

export type Recorder = ReturnType<typeof makeRecorder>;
