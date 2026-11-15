import { strToU8, zipSync } from "fflate";

import { DurationSeconds } from "./duration.ts";
import { libraryExerciseId } from "./exercise-library.ts";
import { contentFingerprint } from "./ids.ts";
import type { ActivityDraft } from "./repositories/activities.ts";
import { EpochMillis, Fingerprint, type ImportBatchId, SourceIdentity } from "./schema.ts";

/**
 * A small, made-up Apple Health export and GPX file, shaped like the real ones, for
 * tests and the simulator proof. No real Health data ever goes in the repo.
 */
const MINUTE = 60_000;

/** 1 November 2026, 07:30 in a +01:00 time zone. */
export const SAMPLE_RUN_START = Date.UTC(2026, 10, 1, 6, 30);
/** 3 November 2026, 18:05 in a +01:00 time zone. It overlaps SAMPLE_HEVY_START. */
export const SAMPLE_STRENGTH_START = Date.UTC(2026, 10, 3, 17, 5);
/** 5 November 2026, 12:00 in a +01:00 time zone. */
export const SAMPLE_RIDE_START = Date.UTC(2026, 10, 5, 11, 0);
/** 6 November 2026, 20:00 in a +01:00 time zone. */
export const SAMPLE_YOGA_START = Date.UTC(2026, 10, 6, 19, 0);
/** 7 November 2026, 09:00 UTC, the standalone GPX ride. */
export const SAMPLE_GPX_START = Date.UTC(2026, 10, 7, 9, 0);
/** The Hevy workout that the Health strength workout copies, 3 November 2026, 18:00 +01:00. */
export const SAMPLE_HEVY_START = Date.UTC(2026, 10, 3, 17, 0);

const pad = (value: number) => String(value).padStart(2, "0");

/** A time as export.xml writes it, in a +01:00 time zone. */
const healthDate = (at: number) => {
  const local = new Date(at + 60 * MINUTE);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} +0100`;
};

const watch = "Sample Watch";
const device = "&lt;&lt;HKDevice: 0x0&gt;, name:Apple Watch, manufacturer:Apple Inc.&gt;";

const heartRecords = (from: number, minutes: number, base: number) =>
  Array.from({ length: minutes * 2 }, (_, index) => {
    const at = from + index * 30_000;
    const bpm = base + ((index * 7) % 25);
    return `  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="${watch}" sourceVersion="11.0" device="${device}" unit="count/min" creationDate="${healthDate(at)}" startDate="${healthDate(at)}" endDate="${healthDate(at)}" value="${bpm}">
   <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="2"/>
  </Record>`;
  });

/** The sample run's route: 61 points due north, about 84 m apart, 5 km in all. */
export const sampleRoutePoints = () =>
  Array.from({ length: 61 }, (_, index) => ({
    at: SAMPLE_RUN_START + index * 30_000,
    latitude: 59.3 + index * 0.000_755,
    longitude: 18.05,
    altitudeM: 20 + (index % 10),
  }));

export const sampleRouteGpx = (): string => `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Apple Health Export" xmlns="http://www.topografix.com/GPX/1/1">
 <metadata><time>${new Date(SAMPLE_RUN_START).toISOString()}</time></metadata>
 <trk>
  <name>Route ${healthDate(SAMPLE_RUN_START)}</name>
  <trkseg>
${sampleRoutePoints()
  .map(
    (point) =>
      `   <trkpt lon="${point.longitude}" lat="${point.latitude.toFixed(6)}"><ele>${point.altitudeM}</ele><time>${new Date(point.at).toISOString()}</time><extensions><speed>2.8</speed><course>0</course><hAcc>3.5</hAcc><vAcc>2.1</vAcc></extensions></trkpt>`,
  )
  .join("\n")}
  </trkseg>
 </trk>
</gpx>
`;

export const SAMPLE_ROUTE_FILE = "/workout-routes/route_2026-11-01_7.30am.gpx";

export const sampleExportXml = (): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!-- HealthKit Export Version: 14 -->
<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout|ActivitySummary|ClinicalRecord|Audiogram|VisionPrescription)*)>
<!ATTLIST HealthData
  locale CDATA #REQUIRED
>
<!ELEMENT Workout ((MetadataEntry|WorkoutEvent|WorkoutRoute|WorkoutStatistics)*)>
<!ATTLIST Workout
  workoutActivityType   CDATA #REQUIRED
  duration              CDATA #IMPLIED
  durationUnit          CDATA #IMPLIED
>
]>
<HealthData locale="en_GB">
 <ExportDate value="${healthDate(SAMPLE_GPX_START)}"/>
 <Me HKCharacteristicTypeIdentifierDateOfBirth="" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexNotSet"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Sample Phone" unit="count" creationDate="${healthDate(SAMPLE_RUN_START)}" startDate="${healthDate(SAMPLE_RUN_START)}" endDate="${healthDate(SAMPLE_RUN_START + MINUTE)}" value="160"/>
 <Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" sourceName="${watch}" unit="ms" creationDate="${healthDate(SAMPLE_RUN_START)}" startDate="${healthDate(SAMPLE_RUN_START)}" endDate="${healthDate(SAMPLE_RUN_START)}" value="48"/>
${heartRecords(SAMPLE_RUN_START - 10 * MINUTE, 5, 60).join("\n")}
${heartRecords(SAMPLE_RUN_START, 30, 140).join("\n")}
${heartRecords(SAMPLE_STRENGTH_START, 55, 100).join("\n")}
${heartRecords(SAMPLE_RIDE_START + 120 * MINUTE, 5, 70).join("\n")}
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" sourceName="${watch}" sourceVersion="11.0" device="${device}" creationDate="${healthDate(SAMPLE_RUN_START + 30 * MINUTE)}" startDate="${healthDate(SAMPLE_RUN_START)}" endDate="${healthDate(SAMPLE_RUN_START + 30 * MINUTE)}">
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
  <WorkoutEvent type="HKWorkoutEventTypeSegment" date="${healthDate(SAMPLE_RUN_START)}" duration="5.5" durationUnit="min"/>
  <WorkoutActivity uuid="00000000-0000-4000-8000-000000000001" startDate="${healthDate(SAMPLE_RUN_START)}" endDate="${healthDate(SAMPLE_RUN_START + 30 * MINUTE)}" duration="30" durationUnit="min">
   <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="${healthDate(SAMPLE_RUN_START)}" endDate="${healthDate(SAMPLE_RUN_START + 30 * MINUTE)}" sum="5.02" unit="km"/>
  </WorkoutActivity>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="${healthDate(SAMPLE_RUN_START)}" endDate="${healthDate(SAMPLE_RUN_START + 30 * MINUTE)}" sum="320" unit="Cal"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="${healthDate(SAMPLE_RUN_START)}" endDate="${healthDate(SAMPLE_RUN_START + 30 * MINUTE)}" sum="5.02" unit="km"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" startDate="${healthDate(SAMPLE_RUN_START)}" endDate="${healthDate(SAMPLE_RUN_START + 30 * MINUTE)}" average="152" minimum="140" maximum="164" unit="count/min"/>
  <WorkoutRoute sourceName="${watch}" sourceVersion="11.0" creationDate="${healthDate(SAMPLE_RUN_START + 30 * MINUTE)}" startDate="${healthDate(SAMPLE_RUN_START)}" endDate="${healthDate(SAMPLE_RUN_START + 30 * MINUTE)}">
   <MetadataEntry key="HKMetadataKeySyncVersion" value="2"/>
   <FileReference path="${SAMPLE_ROUTE_FILE}"/>
  </WorkoutRoute>
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="55" durationUnit="min" sourceName="${watch}" sourceVersion="11.0" creationDate="${healthDate(SAMPLE_STRENGTH_START + 55 * MINUTE)}" startDate="${healthDate(SAMPLE_STRENGTH_START)}" endDate="${healthDate(SAMPLE_STRENGTH_START + 55 * MINUTE)}">
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="${healthDate(SAMPLE_STRENGTH_START)}" endDate="${healthDate(SAMPLE_STRENGTH_START + 55 * MINUTE)}" sum="250" unit="Cal"/>
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="0.75" durationUnit="hr" totalDistance="12.4274" totalDistanceUnit="mi" totalEnergyBurned="1673.6" totalEnergyBurnedUnit="kJ" sourceName="Sample Bike App" creationDate="${healthDate(SAMPLE_RIDE_START + 45 * MINUTE)}" startDate="${healthDate(SAMPLE_RIDE_START)}" endDate="${healthDate(SAMPLE_RIDE_START + 45 * MINUTE)}"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeYoga" duration="20" durationUnit="min" sourceName="${watch}" creationDate="${healthDate(SAMPLE_YOGA_START + 20 * MINUTE)}" startDate="${healthDate(SAMPLE_YOGA_START)}" endDate="${healthDate(SAMPLE_YOGA_START + 20 * MINUTE)}"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="20" durationUnit="min" sourceName="${watch}" creationDate="not a date" startDate="not a date" endDate="not a date"/>
 <ActivitySummary dateComponents="2026-11-01" activeEnergyBurned="500" activeEnergyBurnedGoal="600" activeEnergyBurnedUnit="Cal"/>
</HealthData>
`;

/** export.zip as the Health app shares it, with export_cda.xml beside export.xml. */
export const sampleHealthZip = (): Uint8Array =>
  zipSync({
    "apple_health_export/export.xml": strToU8(sampleExportXml()),
    "apple_health_export/export_cda.xml": strToU8(
      '<?xml version="1.0"?>\n<ClinicalDocument xmlns="urn:hl7-org:v3"></ClinicalDocument>\n',
    ),
    [`apple_health_export${SAMPLE_ROUTE_FILE}`]: strToU8(sampleRouteGpx()),
  });

/** A Strava-style GPX ride with heart rate in each point's extension, 40 minutes long. */
export const sampleGpx = (): string => `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="Sample Bike Computer" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
 <metadata><time>${new Date(SAMPLE_GPX_START).toISOString()}</time></metadata>
 <trk>
  <name>Saturday ride &amp; coffee</name>
  <type>cycling</type>
  <trkseg>
${Array.from(
  { length: 41 },
  (_, index) =>
    `   <trkpt lat="${(59.33 + index * 0.0045).toFixed(6)}" lon="18.07"><ele>${30 + (index % 5)}</ele><time>${new Date(SAMPLE_GPX_START + index * MINUTE).toISOString()}</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${120 + (index % 20)}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>`,
).join("\n")}
  </trkseg>
 </trk>
</gpx>
`;

/** A strength workout shaped like a Hevy import, at the time the Health strength workout copies. */
export const sampleHevyDraft = (importBatchId: ImportBatchId): ActivityDraft => {
  const exercises = [
    { libraryId: "Barbell_Bench_Press_-_Medium_Grip", kg: 80 },
    { libraryId: "Standing_Military_Press", kg: 45 },
    { libraryId: "Triceps_Pushdown", kg: 30 },
  ];
  const content = { title: "Push day", start: SAMPLE_HEVY_START, exercises };
  return {
    kind: "strength",
    startedAt: EpochMillis.make(SAMPLE_HEVY_START),
    durationS: DurationSeconds.make(3600),
    title: "Push day",
    notes: "",
    energyKcal: null,
    audience: "only_you",
    hiddenFields: [],
    origin: {
      source: "hevy",
      sourceId: SourceIdentity.make(new Date(SAMPLE_HEVY_START).toISOString()),
      fingerprint: Fingerprint.make(contentFingerprint(content)),
      importBatchId,
    },
    exercises: exercises.map(({ libraryId, kg }) => ({
      exerciseId: libraryExerciseId(libraryId),
      supersetGroup: null,
      notes: "",
      sets: [0, 1, 2].map(() => ({
        setType: "normal" as const,
        weightKg: kg,
        reps: 8,
        durationS: null,
        distanceM: null,
        rpe: null,
      })),
    })),
    track: null,
  };
};
