import {
  type BarsAndPlates,
  type BarsAndPlatesByUnit,
  GearRepository,
  type WeightUnit,
} from "@svett/core";
import { Effect } from "effect";
import { Alert, View } from "react-native";

import { type Query, useQuery, write } from "../data/store";
import { EmptyState } from "../ui/EmptyState";

const readAll = () => Effect.flatMap(Effect.service(GearRepository), (gear) => gear.all);

/** Your plates and bars in each unit, read again after every write, an import's too. */
export const useBarsAndPlates = (): Query<BarsAndPlatesByUnit> =>
  useQuery("bars-and-plates", readAll);

// Changes save one at a time, each worked out from the one before, so fast presses all count.
let changes: Promise<unknown> = Promise.resolve();

/** Saves a change to your plates and bars in `unit`, worked out from what is saved. */
export const changeBarsAndPlates = (
  unit: WeightUnit,
  change: (gear: BarsAndPlates) => BarsAndPlates,
) => {
  changes = changes
    .then(() =>
      write(
        Effect.flatMap(Effect.service(GearRepository), (gear) =>
          Effect.flatMap(gear.all, (current) => gear.save(unit, change(current[unit]))),
        ),
      ),
    )
    .catch((error: unknown) => Alert.alert("Your plates and bars were not saved", String(error)));
};

/** What a screen of plates and bars shows while they load, or why they did not. */
export function GearNotReady({ query }: { readonly query: Query<unknown> }) {
  return (
    <View className="flex-1 justify-center bg-background">
      {query.status === "failed" ? (
        <EmptyState
          symbol="exclamationmark.triangle"
          title="Your plates and bars did not load"
          message={query.message}
        />
      ) : null}
    </View>
  );
}
