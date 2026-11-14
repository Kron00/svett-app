import { Effect, Exit, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_BARS_AND_PLATES } from "../plates.ts";
import { decodeSvettFile } from "../svett-file.ts";
import { openTestDatabase } from "../test-database.ts";
import { GearRepository } from "./gear.ts";
import { TransferRepository } from "./transfer.ts";

type Database = ReturnType<typeof openTestDatabase>;

const MY_KG = {
  plates: [
    { weight: 20, pairs: 4 },
    { weight: 0.5, pairs: 2 },
  ],
  bars: [
    { name: "Barbell", weight: 20 },
    { name: "Safety squat bar", weight: 30 },
  ],
};

const gear = <A, E>(
  database: Database,
  body: (repository: typeof GearRepository.Service) => Effect.Effect<A, E>,
) => database.runtime.runPromise(Effect.flatMap(Effect.service(GearRepository), body));

const exportText = (database: Database) =>
  database.runtime.runPromise(
    Effect.flatMap(Effect.service(TransferRepository), (transfer) => transfer.exportFile),
  );

const importText = (database: Database, text: string) =>
  database.runtime.runPromise(
    Effect.flatMap(Effect.service(TransferRepository), (transfer) =>
      transfer.applyImport(Result.getOrThrow(decodeSvettFile(text)), []),
    ),
  );

describe("GearRepository", () => {
  it("has a commercial gym's plates and bars in both units before you change any", async () => {
    const database = openTestDatabase();
    expect(await gear(database, (repository) => repository.all)).toEqual(DEFAULT_BARS_AND_PLATES);
  });

  it("keeps your plates and bars per unit, one set each, the last saved", async () => {
    const database = openTestDatabase();
    await gear(database, (repository) => repository.save("kg", DEFAULT_BARS_AND_PLATES.kg));
    await gear(database, (repository) => repository.save("kg", MY_KG));

    expect(await gear(database, (repository) => repository.all)).toEqual({
      kg: MY_KG,
      lb: DEFAULT_BARS_AND_PLATES.lb,
    });
    expect(database.database.prepare("SELECT count(*) AS n FROM gear").get()).toEqual({ n: 1 });
  });

  it("refuses plates and bars with no bar, and keeps what you had", async () => {
    const database = openTestDatabase();
    await gear(database, (repository) => repository.save("kg", MY_KG));

    const refused = await database.runtime.runPromiseExit(
      Effect.flatMap(Effect.service(GearRepository), (repository) =>
        repository.save("kg", { plates: MY_KG.plates, bars: [] }),
      ),
    );

    expect(Exit.isFailure(refused)).toBe(true);
    expect((await gear(database, (repository) => repository.all)).kg).toEqual(MY_KG);
  });

  it("survives export, a wiped phone and import", async () => {
    const phone = openTestDatabase(1);
    await gear(phone, (repository) => repository.save("kg", MY_KG));
    const { text } = await exportText(phone);

    const wiped = openTestDatabase(2);
    await importText(wiped, text);

    expect(await gear(wiped, (repository) => repository.all)).toEqual({
      kg: MY_KG,
      lb: DEFAULT_BARS_AND_PLATES.lb,
    });
  });

  it("stays as you set it when a file from before plates and bars is imported", async () => {
    const older = openTestDatabase(1);
    const { text } = await exportText(older);
    const version4 = JSON.parse(text) as { version: number; tables: Record<string, unknown> };
    version4.version = 4;
    delete version4.tables["gear"];

    const phone = openTestDatabase(2);
    await gear(phone, (repository) => repository.save("kg", MY_KG));
    await importText(phone, JSON.stringify(version4));

    expect((await gear(phone, (repository) => repository.all)).kg).toEqual(MY_KG);
  });
});
