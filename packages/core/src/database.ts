import { Effect, Layer, Schema } from "effect";

import { Ids } from "./ids.ts";
import { migrate } from "./migrations.ts";
import { ActivityRepository } from "./repositories/activities.ts";
import { ExerciseAliasRepository, ExerciseRepository } from "./repositories/exercises.ts";
import { GearRepository } from "./repositories/gear.ts";
import { ProgressRepository } from "./repositories/progress.ts";
import { HistoryRepository } from "./repositories/history.ts";
import {
  CoachMessageRepository,
  ImportRepository,
  MeasurementRepository,
  ProposalRepository,
} from "./repositories/records.ts";
import { RoutineRepository } from "./repositories/routines.ts";
import { TrainingReads } from "./repositories/training.ts";
import { TransferRepository } from "./repositories/transfer.ts";
import { Sql, type SqlDriver } from "./sql.ts";

export const AccountId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)).pipe(
  Schema.brand("AccountId"),
);
export type AccountId = typeof AccountId.Type;

/** Whose data a database holds. Each owner has its own file, so accounts never mix. */
export type DatabaseOwner =
  | { readonly kind: "anonymous" }
  | { readonly kind: "account"; readonly accountId: AccountId };

export const ANONYMOUS: DatabaseOwner = { kind: "anonymous" };

export const databaseFileName = (owner: DatabaseOwner): string =>
  owner.kind === "anonymous" ? "svett-anonymous.db" : `svett-account-${owner.accountId}.db`;

export const Repositories = Layer.mergeAll(
  ActivityRepository.layer,
  ExerciseRepository.layer,
  ExerciseAliasRepository.layer,
  RoutineRepository.layer,
  MeasurementRepository.layer,
  ImportRepository.layer,
  ProposalRepository.layer,
  CoachMessageRepository.layer,
  ProgressRepository.layer,
  HistoryRepository.layer,
  TransferRepository.layer,
  GearRepository.layer,
  TrainingReads.layer,
);

/** The steps of opening a database that the app times at launch. */
export type OpenStep = "migrated" | "seeded";

const prepared = (onStep: (step: OpenStep) => void) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* migrate();
      yield* Effect.sync(() => onStep("migrated"));
      const exercises = yield* ExerciseRepository;
      yield* exercises.seedLibrary();
      yield* Effect.sync(() => onStep("seeded"));
    }),
  );

/**
 * An open, migrated database with the exercise library seeded, and every repository over it.
 * Opening the same file again finds nothing left to do. `onStep` hears when each step is done.
 */
export const databaseLayer = (
  driver: SqlDriver,
  ids: Layer.Layer<Ids>,
  onStep: (step: OpenStep) => void = () => {},
) => {
  const base = Layer.merge(Sql.layer(driver), ids);
  const repositories = Repositories.pipe(Layer.provideMerge(base));
  return Layer.provideMerge(prepared(onStep), repositories);
};
