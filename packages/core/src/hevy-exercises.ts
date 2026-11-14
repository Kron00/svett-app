import type { Equipment } from "./schema.ts";

/**
 * Hevy's names for common exercises, and the library exercise each one is. A name that is not
 * here, or that you matched yourself, goes through the match screen once.
 */
export const HEVY_LIBRARY: Readonly<Record<string, string>> = {
  "Bench Press (Barbell)": "Barbell_Bench_Press_-_Medium_Grip",
  "Bench Press (Dumbbell)": "Dumbbell_Bench_Press",
  "Bench Press (Smith Machine)": "Smith_Machine_Bench_Press",
  "Incline Bench Press (Barbell)": "Barbell_Incline_Bench_Press_-_Medium_Grip",
  "Incline Bench Press (Dumbbell)": "Incline_Dumbbell_Press",
  "Incline Bench Press (Smith Machine)": "Smith_Machine_Incline_Bench_Press",
  "Decline Bench Press (Barbell)": "Decline_Barbell_Bench_Press",
  "Decline Bench Press (Dumbbell)": "Decline_Dumbbell_Bench_Press",
  "Close Grip Bench Press (Barbell)": "Close-Grip_Barbell_Bench_Press",
  "Floor Press (Barbell)": "Floor_Press",
  "Chest Press (Machine)": "Machine_Bench_Press",
  "Chest Fly (Dumbbell)": "Dumbbell_Flyes",
  "Incline Chest Fly (Dumbbell)": "Incline_Dumbbell_Flyes",
  "Butterfly (Pec Deck)": "Butterfly",
  "Cable Fly Crossovers": "Cable_Crossover",
  "Low Cable Fly Crossovers": "Low_Cable_Crossover",
  "Push Up": "Pushups",
  "Decline Push Up": "Decline_Push-Up",
  "Incline Push Ups": "Incline_Push-Up",
  "Chest Dip": "Dips_-_Chest_Version",
  "Triceps Dip": "Dips_-_Triceps_Version",
  "Bench Dip": "Bench_Dips",
  "Squat (Barbell)": "Barbell_Squat",
  "Full Squat": "Barbell_Full_Squat",
  "Front Squat": "Front_Barbell_Squat",
  "Goblet Squat": "Goblet_Squat",
  "Squat (Dumbbell)": "Dumbbell_Squat",
  "Squat (Smith Machine)": "Smith_Machine_Squat",
  "Box Squat (Barbell)": "Box_Squat",
  "Overhead Squat": "Overhead_Squat",
  "Zercher Squat": "Zercher_Squats",
  "Hack Squat (Machine)": "Hack_Squat",
  "Air Squat": "Bodyweight_Squat",
  "Leg Press (Machine)": "Leg_Press",
  "Bulgarian Split Squat": "Split_Squat_with_Dumbbells",
  "Split Squat (Dumbbell)": "Split_Squat_with_Dumbbells",
  "Lunge (Barbell)": "Barbell_Lunge",
  "Lunge (Dumbbell)": "Dumbbell_Lunges",
  "Walking Lunge": "Bodyweight_Walking_Lunge",
  "Walking Lunge (Barbell)": "Barbell_Walking_Lunge",
  "Leg Extension (Machine)": "Leg_Extensions",
  "Lying Leg Curl (Machine)": "Lying_Leg_Curls",
  "Seated Leg Curl (Machine)": "Seated_Leg_Curl",
  "Standing Leg Curls": "Standing_Leg_Curl",
  "Glute Ham Raise": "Glute_Ham_Raise",
  "Standing Calf Raise (Machine)": "Standing_Calf_Raises",
  "Standing Calf Raise (Barbell)": "Standing_Barbell_Calf_Raise",
  "Standing Calf Raise (Dumbbell)": "Standing_Dumbbell_Calf_Raise",
  "Seated Calf Raise": "Seated_Calf_Raise",
  "Calf Press (Machine)": "Calf_Press",
  "Hip Abduction (Machine)": "Thigh_Abductor",
  "Hip Adduction (Machine)": "Thigh_Adductor",
  "Hip Thrust (Barbell)": "Barbell_Hip_Thrust",
  "Glute Bridge": "Barbell_Glute_Bridge",
  "Single Leg Glute Bridge": "Single_Leg_Glute_Bridge",
  "Glute Kickback (Machine)": "Glute_Kickback",
  "Deadlift (Barbell)": "Barbell_Deadlift",
  "Deadlift (Trap bar)": "Trap_Bar_Deadlift",
  "Sumo Deadlift": "Sumo_Deadlift",
  "Romanian Deadlift (Barbell)": "Romanian_Deadlift",
  "Romanian Deadlift (Dumbbell)": "Stiff-Legged_Dumbbell_Deadlift",
  "Straight Leg Deadlift": "Stiff-Legged_Barbell_Deadlift",
  "Deficit Deadlift": "Deficit_Deadlift",
  "Rack Pull": "Rack_Pulls",
  "Good Morning (Barbell)": "Good_Morning",
  "Back Extension (Hyperextension)": "Hyperextensions_Back_Extensions",
  "Reverse Hyperextension": "Reverse_Hyperextension",
  "Overhead Press (Barbell)": "Standing_Military_Press",
  "Seated Overhead Press (Barbell)": "Seated_Barbell_Military_Press",
  "Overhead Press (Dumbbell)": "Dumbbell_Shoulder_Press",
  "Seated Overhead Press (Dumbbell)": "Seated_Dumbbell_Press",
  "Overhead Press (Smith Machine)": "Smith_Machine_Overhead_Shoulder_Press",
  "Shoulder Press (Machine Plates)": "Leverage_Shoulder_Press",
  "Shoulder Press (Machine)": "Machine_Shoulder_Military_Press",
  "Arnold Press (Dumbbell)": "Arnold_Dumbbell_Press",
  "Push Press": "Push_Press",
  "Lateral Raise (Dumbbell)": "Side_Lateral_Raise",
  "Seated Lateral Raise (Dumbbell)": "Seated_Side_Lateral_Raise",
  "Front Raise (Dumbbell)": "Front_Dumbbell_Raise",
  "Front Raise (Cable)": "Front_Cable_Raise",
  "Front Raise (Plate)": "Front_Plate_Raise",
  "Rear Delt Reverse Fly (Dumbbell)": "Seated_Bent-Over_Rear_Delt_Raise",
  "Rear Delt Reverse Fly (Machine)": "Reverse_Machine_Flyes",
  "Rear Delt Reverse Fly (Cable)": "Cable_Rear_Delt_Fly",
  "Face Pull": "Face_Pull",
  "Upright Row (Barbell)": "Upright_Barbell_Row",
  "Upright Row (Cable)": "Upright_Cable_Row",
  "Upright Row (Dumbbell)": "Standing_Dumbbell_Upright_Row",
  "Shrug (Barbell)": "Barbell_Shrug",
  "Shrug (Dumbbell)": "Dumbbell_Shrug",
  "Shrug (Cable)": "Cable_Shrugs",
  "Shrug (Smith Machine)": "Smith_Machine_Behind_the_Back_Shrug",
  "Bent Over Row (Barbell)": "Bent_Over_Barbell_Row",
  "Bent Over Row (Dumbbell)": "Bent_Over_Two-Dumbbell_Row",
  "Dumbbell Row": "One-Arm_Dumbbell_Row",
  "Chest Supported Incline Row (Dumbbell)": "Dumbbell_Incline_Row",
  "T Bar Row": "T-Bar_Row_with_Handle",
  "Seated Cable Row - V Grip (Cable)": "Seated_Cable_Rows",
  "Seated Row (Machine)": "Leverage_Iso_Row",
  "Inverted Row": "Inverted_Row",
  "Lat Pulldown (Cable)": "Wide-Grip_Lat_Pulldown",
  "Lat Pulldown - Close Grip (Cable)": "Close-Grip_Front_Lat_Pulldown",
  "Single Arm Lat Pulldown": "One_Arm_Lat_Pulldown",
  "Reverse Grip Lat Pulldown (Cable)": "Underhand_Cable_Pulldowns",
  "Straight Arm Lat Pulldown (Cable)": "Straight-Arm_Pulldown",
  "Pull Up": "Pullups",
  "Pull Up (Weighted)": "Weighted_Pull_Ups",
  "Pull Up (Assisted)": "Band_Assisted_Pull-Up",
  "Chin Up": "Chin-Up",
  "Pullover (Dumbbell)": "Straight-Arm_Dumbbell_Pullover",
  "Bicep Curl (Barbell)": "Barbell_Curl",
  "Bicep Curl (Dumbbell)": "Dumbbell_Bicep_Curl",
  "Bicep Curl (Cable)": "Standing_Biceps_Cable_Curl",
  "Bicep Curl (Machine)": "Machine_Bicep_Curl",
  "EZ Bar Biceps Curl": "EZ-Bar_Curl",
  "Hammer Curl (Dumbbell)": "Hammer_Curls",
  "Hammer Curl (Cable)": "Cable_Hammer_Curls_-_Rope_Attachment",
  "Preacher Curl (Barbell)": "Preacher_Curl",
  "Preacher Curl (Dumbbell)": "One_Arm_Dumbbell_Preacher_Curl",
  "Preacher Curl (Machine)": "Machine_Preacher_Curls",
  "Concentration Curl": "Concentration_Curls",
  "Seated Incline Curl (Dumbbell)": "Incline_Dumbbell_Curl",
  "Reverse Curl (Barbell)": "Reverse_Barbell_Curl",
  "Drag Curl": "Drag_Curl",
  "Zottman Curl (Dumbbell)": "Zottman_Curl",
  "Triceps Pushdown": "Triceps_Pushdown",
  "Triceps Rope Pushdown": "Triceps_Pushdown_-_Rope_Attachment",
  "Skullcrusher (Barbell)": "Lying_Triceps_Press",
  "Skullcrusher (Dumbbell)": "Lying_Dumbbell_Tricep_Extension",
  "Triceps Extension (Cable)": "Cable_Rope_Overhead_Triceps_Extension",
  "Overhead Triceps Extension (Cable)": "Cable_Rope_Overhead_Triceps_Extension",
  "Triceps Extension (Dumbbell)": "Standing_Dumbbell_Triceps_Extension",
  "Triceps Extension (Barbell)": "Standing_Overhead_Barbell_Triceps_Extension",
  "Triceps Extension (Machine)": "Machine_Triceps_Extension",
  "Triceps Kickback (Dumbbell)": "Tricep_Dumbbell_Kickback",
  "JM Press": "JM_Press",
  "Wrist Curl (Barbell)": "Palms-Up_Barbell_Wrist_Curl_Over_A_Bench",
  "Plank": "Plank",
  "Crunch": "Crunches",
  "Crunch (Machine)": "Ab_Crunch_Machine",
  "Cable Crunch": "Cable_Crunch",
  "Decline Crunch": "Decline_Crunch",
  "Reverse Crunch": "Reverse_Crunch",
  "Sit Up": "Sit-Up",
  "Hanging Leg Raise": "Hanging_Leg_Raise",
  "Lying Leg Raise": "Flat_Bench_Lying_Leg_Raise",
  "Ab Wheel": "Ab_Roller",
  "Russian Twist (Weighted)": "Russian_Twist",
  "Mountain Climber": "Mountain_Climbers",
  "Pallof Press": "Pallof_Press",
  "Side Plank": "Side_Bridge",
  "Farmers Walk": "Farmers_Walk",
  "Kettlebell Swing": "One-Arm_Kettlebell_Swings",
  "Kettlebell Turkish Get Up": "Kettlebell_Turkish_Get-Up_Squat_style",
  "Power Clean": "Power_Clean",
  "Hang Clean": "Hang_Clean",
  "Clean": "Clean",
  "Clean and Jerk": "Clean_and_Jerk",
  "Clean and Press": "Clean_and_Press",
  "Snatch": "Snatch",
  "Power Snatch": "Power_Snatch",
  "Thruster (Kettlebell)": "Kettlebell_Thruster",
  "Box Jump": "Front_Box_Jump",
  "Jump Squat": "Freehand_Jump_Squat",
  "Jump Rope": "Rope_Jumping",
  "Treadmill": "Running_Treadmill",
  "Walking": "Walking_Treadmill",
  "Rowing Machine": "Rowing_Stationary",
  "Cycling": "Bicycling",
  "Spinning": "Bicycling_Stationary",
  "Air Bike": "Air_Bike",
  "Elliptical Trainer": "Elliptical_Trainer",
  "Sled Push": "Prowler_Sprint",
};

/** The equipment Hevy names in brackets after an exercise, such as Curl (Dumbbell). */
const EQUIPMENT_WORDS: ReadonlyArray<readonly [RegExp, Equipment]> = [
  [/\b(smith machine|machine|machine plates|pec deck|leverage)\b/i, "machine"],
  [/\bbarbell|trap bar\b/i, "barbell"],
  [/\bdumbbell\b/i, "dumbbell"],
  [/\bkettlebell\b/i, "kettlebell"],
  [/\bcable\b/i, "cable"],
  [/\bband\b/i, "band"],
  [/\bez bar\b/i, "ez_bar"],
  [/\bplate\b/i, "plate"],
  [/\b(bodyweight|weighted|assisted)\b/i, "none"],
];

/** The equipment of an exercise known only by its Hevy name, or other when it does not say. */
export const equipmentFromName = (name: string): Equipment => {
  const bracket = /\(([^)]*)\)\s*$/.exec(name)?.[1] ?? "";
  return EQUIPMENT_WORDS.find(([pattern]) => pattern.test(bracket))?.[1] ?? "other";
};

const STOP_WORDS = new Set(["a", "an", "and", "the", "with", "on", "to", "of", "-"]);

const words = (name: string): ReadonlyArray<string> =>
  name
    .toLowerCase()
    .replaceAll(/[()_,/-]+/g, " ")
    .split(/\s+/)
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word))
    .filter((word) => word !== "" && !STOP_WORDS.has(word));

/**
 * The exercises whose names share the most words with `name`, best first, for the match
 * screen. Each shared word counts once, and a shorter name wins a tie, so "Bench Press
 * (Barbell)" puts Barbell Bench Press before Barbell Bench Press with Chains.
 */
export const suggestExercises = <A extends { readonly name: string }>(
  name: string,
  exercises: ReadonlyArray<A>,
  limit = 3,
): ReadonlyArray<A> => {
  const wanted = new Set(words(name));
  return exercises
    .map((exercise) => {
      const theirs = new Set(words(exercise.name));
      const shared = [...wanted].filter((word) => theirs.has(word)).length;
      return { exercise, shared, extra: theirs.size - shared };
    })
    .filter(({ shared }) => shared > 0)
    .sort(
      (a, b) =>
        b.shared - a.shared || a.extra - b.extra || a.exercise.name.localeCompare(b.exercise.name),
    )
    .slice(0, limit)
    .map(({ exercise }) => exercise);
};
