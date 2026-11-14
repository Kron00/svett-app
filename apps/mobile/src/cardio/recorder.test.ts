import { ActivityId, encodeRecordingEvent, type LocationReading } from "@svett/core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Task = (body: {
  data: { locations: ReadonlyArray<LocationReading> };
  error: unknown;
}) => Promise<void>;

const phone = vi.hoisted(() => ({
  journal: "",
  diskFull: false,
  task: undefined as Task | undefined,
}));

vi.mock("expo-file-system", () => ({
  Paths: { document: "/documents" },
  File: class {
    get exists() {
      return phone.journal !== "";
    }
    textSync() {
      return phone.journal;
    }
    async write(text: string) {
      if (phone.diskFull) throw new Error("No space left on device");
      phone.journal += text;
    }
    delete() {
      phone.journal = "";
    }
  },
}));
vi.mock("expo-location", () => ({
  hasStartedLocationUpdatesAsync: async () => true,
  startLocationUpdatesAsync: async () => undefined,
  stopLocationUpdatesAsync: async () => undefined,
  Accuracy: { BestForNavigation: 6 },
  ActivityType: { Fitness: 3 },
}));
vi.mock("expo-task-manager", () => ({
  defineTask: (_name: string, task: Task) => {
    phone.task = task;
  },
}));
vi.mock("../data/database", () => ({ appDatabase: () => undefined }));

const T = 1_800_000_000_000;
phone.journal = `${encodeRecordingEvent({
  type: "start",
  at: T,
  kind: "run",
  activityId: ActivityId.make("0190a000-0000-7000-8000-000000000001"),
})}\n`;

const { recording, recordingProblem } = await import("./recorder");

/** iOS handing svett a batch of readings while the screen is locked. */
const deliver = (seconds: number) =>
  phone.task!({
    data: {
      locations: [
        {
          timestamp: T + seconds * 1000,
          coords: {
            latitude: 0,
            longitude: 0,
            altitude: null,
            accuracy: 5,
            altitudeAccuracy: null,
          },
        },
      ],
    },
    error: null,
  });

describe("readings delivered in the background", () => {
  beforeEach(() => {
    phone.diskFull = false;
    recordingProblem.set(undefined);
  });

  it("says GPS readings are being lost when the journal refuses them", async () => {
    phone.diskFull = true;
    await deliver(1);
    expect(recordingProblem.get()).toBe("GPS readings are being lost. No space left on device");
    expect(recording.get()?.segments[0]?.pending).toBeNull();
  });

  it("clears that once readings are saved again", async () => {
    phone.diskFull = true;
    await deliver(2);
    phone.diskFull = false;
    await deliver(3);
    expect(recordingProblem.get()).toBeUndefined();
    // The reading waits there for a later one to confirm it.
    expect(recording.get()?.segments[0]?.pending?.at).toBe(T + 3000);
  });

  it("keeps a problem it did not report when readings are saved", async () => {
    recordingProblem.set("GPS would not stop.");
    await deliver(4);
    expect(recordingProblem.get()).toBe("GPS would not stop.");
  });
});
