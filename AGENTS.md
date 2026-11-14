# svett.app

svett is an iPhone app for lifting and cardio. It has one feed for every kind of workout. Users can export all their data and import it back. A coach runs on the user's own ChatGPT plan after **Continue with ChatGPT**.

`docs/plan.html` is the approved build plan. Read it before you change anything. It names every pull request, its proof, and the rules the code keeps.

## Machines

| Machine               | Job                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| rena-devbox (Linux)   | Main working copy. Agents, package installs, type checks, lint, unit tests, and the phase 6 server.                                       |
| rena-devbook (Mac)    | Native iOS builds, the Metro dev server for the simulator, and the iPhone 16 Pro Max simulator.                                           |
| rena (Mac laptop)     | Real-phone work through iPhone Mirroring, only when a task needs the phone.                                                               |
| GitHub hosted runners | Lint, type checks, tests, an iOS compile check, and the release job after each merge. Never add a self-hosted runner: the repo is public. |

## Rules

- Every pull request goes through the sol loop and then the council. It merges only when both council reviewers score it 9 or higher.
- Phone sessions are read-only unless the task says otherwise. Do not sign in or out, buy, start trials, post, like, follow, comment, or save or delete any workout or activity.
- Never commit `research/screenshots/`, real names, email addresses, IP addresses, user names, tokens or a real Hevy export.
- `research/features.md` is the Hevy and Strava feature inventory the plan is based on.

## Develop

Node and pnpm versions are pinned in `.node-version` and `packageManager`. On rena-devbox, Node 26 comes from fnm. Put it on the path with `eval "$(fnm env)" && fnm use` before running anything.

On rena-devbox:

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm fmt
```

`pnpm --filter @svett/mobile exec expo export --platform ios` bundles the app's JavaScript. It proves the app bundles without a Mac.

On rena-devbook, after the branch is pushed:

```sh
~/svett-app/scripts/devbook-build.sh <branch>                     # Debug build, Metro on localhost:8081
SVETT_METRO=host:port ~/svett-app/scripts/devbook-build.sh <branch> # Debug build against another Metro
~/svett-app/scripts/devbook-build.sh --release <branch>           # Release build, JS embedded, no Metro
~/svett-app/scripts/devbook-build.sh --native <branch>            # Force the native build
~/svett-app/scripts/sim/tabs.sh [out-dir]                         # Proof screenshots of a Debug build
~/svett-app/scripts/sim/tabs.sh --release [out-dir]               # Proof screenshots of a Release build
~/svett-app/scripts/sim/launch.sh [--release] [app-argument...]   # Relaunch with launch arguments
~/svett-app/scripts/sim/gallery.sh [--release] [out-dir]           # Design gallery at the default and the largest text size
~/svett-app/scripts/sim/checks.sh [--release] [out-dir]           # Run every phone check and save the report
~/svett-app/scripts/sim/chatgpt.sh [--release] [out-dir]          # Swift tests, then every ChatGPT sign-in state on the stand-in
~/svett-app/scripts/sim/chatgpt.sh --live [--release] [out-dir]   # Sign in with a real ChatGPT account, on request only
~/svett-app/scripts/sim/exercises.sh [--release] [out-dir]        # Search the library and prove a custom exercise survives a restart
~/svett-app/scripts/sim/progress.sh [--release] [out-dir]         # Progress charts on the 300-workout fixture
~/svett-app/scripts/sim/coach.sh [--release] [out-dir]            # Swift tests, then the coach's states and answer on the stand-in
~/svett-app/scripts/sim/coach.sh --live [--release] [out-dir]     # Ask OpenAI with a real account and record the exchange
```

`devbook-build.sh` syncs `~/svett-app` to the branch, installs packages, builds the app for the simulator, installs it and opens it. It signs the simulator app to run locally, with no team, so the app carries its entitlements. The Keychain and Apple Health refuse an app without them. Metro's log is `~/svett-app/metro.log`. The first run needs the clone, so run it from a copy of the script or clone the repo to `~/svett-app` first.

`SVETT_METRO` is the one Metro address setting, `localhost:8081` by default. A host with no port means port 8081. `devbook-build.sh`, `sim/tabs.sh` and `sim/launch.sh` all open a Debug build on it. When its host is `localhost`, `devbook-build.sh` starts Metro on that port first. Otherwise it expects Metro already running there.

Agents on the Mac run in non-interactive shells that skip `~/.zshrc`. When `fnm` or `pod` is not on `PATH`, `devbook-build.sh` also looks in `~/.local/share/fnm/` and in the newest `~/.local/share/mise/installs/ruby/*/bin/`.

The native build runs only when needed. The script compares the Expo fingerprint of the native inputs with the one saved after the last successful build in `~/svett-app-build/<configuration>/`, which also holds the build output. When they match, a Debug run skips `expo prebuild`, `pod install` and `xcodebuild`, and goes straight to installing and starting Metro. Otherwise `expo prebuild` and `pod install` run only when `apps/mobile/ios` was generated from other native inputs, which it records in `apps/mobile/ios/.svett-fingerprint`. A Release run always runs `xcodebuild` to embed the current JavaScript. The script prints which path it took. Pass `--native` to force the full build.

The scripts use the simulator named by `SVETT_SIMULATOR`, by default a dedicated `svett iPhone 16 Pro Max` on iOS 27. `devbook-build.sh` creates it when it is missing. Names match exactly, so the stock `iPhone 16 Pro Max` is never picked by accident.

`sim/tabs.sh` drives the simulator with `agent-device`. It opens the app, taps each of the five tabs, and saves numbered screenshots to `out-dir`, by default `~/svett-proof/<branch>/`. Pass `--release` after a Release build so it opens the app without Metro.

`sim/launch.sh` relaunches the app and passes each extra argument to the app process, for example `sim/launch.sh -svettFixture /path/to/fixture.json`. Pass `--release` after a Release build. It leaves the app running.

`sim/gallery.sh` opens the design gallery twice, at the default and at the largest accessibility text size. Each pass saves a screenshot per page until the gallery's end marker is on screen, then one of the open sheet, as `<pass>-NN.png` and `<pass>-sheet.png` in `out-dir`, by default `~/svett-proof/<branch>/gallery/`. It sets the text size with `agent-device settings text-size`, and leaves the simulator at the default size. It reaches the gallery and the sheet through the `svett://gallery` and `svett://gallery?sheet=open` links, because agent-device 0.21.37 refuses taps in screen content on iOS 27. It reads UIKit's touch-transparent floating bar containers as toolbars covering the screen. It takes `SVETT_DEVICE_CMD`, `SVETT_METRO` and `--release` like `sim/tabs.sh`.

`sim/checks.sh` runs every phone check on the simulator. It opens Phone checks from the You tab and resets the checks. It relaunches and reopens Phone checks for the Keychain check. It grants notifications ahead, presses Run on the notification check and goes to the Home Screen in the next call, because the notification is due 10 seconds later. It waits there for the banner and comes back. It runs Apple Health and allows the sheet when it shows. It moves the simulator along a route with `simctl location` and keeps svett in the background for 70 seconds for GPS. It opens the ChatGPT sign-in sheet and cancels it. After each step that leaves svett it opens svett again without a relaunch, reopens Phone checks from the You tab when svett comes back elsewhere, and stops with an error before any scroll or press while svett is not in front. Last it relaunches, copies the report and saves the clipboard as `report.txt`, with a note that GPS ran on the Home Screen because the simulator cannot lock. A Debug report also notes that a development client reload forgets when svett was away. Numbered screenshots and the report go to `out-dir`, by default `~/svett-proof/<branch>/checks/`. It takes `SVETT_DEVICE_CMD`, `SVETT_METRO` and `--release` like `sim/tabs.sh`. agent-device 0.21.37 refuses a selector press inside screen content on iOS 27 as covered, because it reads UIKit's touch-transparent floating bar containers as toolbars over the screen. A press at coordinates skips that check, so the script reads an element's frame with `agent-device get attrs` and presses its centre.

`sim/chatgpt.sh` first runs `scripts/chatgpt-tests.sh`, which runs `swift test` on the ChatGPT sign-in's Swift package and saves the output as `swift-test.txt`. Then, at the largest text size, it relaunches svett with each `-svettChatGPTStub` scenario, opens the ChatGPT settings through `svett://chatgpt` and walks every state against the stand-in for OpenAI. It fails when a state or message it expects does not show. `--live` instead waits up to 10 minutes for a person to sign in with a real account, then signs out. Screenshots go to `out-dir`, by default `~/svett-proof/<branch>/chatgpt/`. It takes `SVETT_DEVICE_CMD`, `SVETT_METRO` and `--release` like `sim/tabs.sh`.

`sim/exercises.sh` proves the exercise library at the largest text size. It opens `svett://exercises?q=barbell%20squat`, checks the first result is Barbell Squat and opens it. It opens `svett://exercises/new` filled with a name unique to the run, presses Save and checks the detail says Custom. Then it relaunches, searches for that name and opens it again. It fails when a screen, the expected first result or the saved exercise is missing. `SVETT_EXERCISE_NAME` sets the name. Numbered screenshots go to `out-dir`, by default `~/svett-proof/<branch>/exercises/`. It takes `SVETT_DEVICE_CMD`, `SVETT_METRO` and `--release` like `sim/tabs.sh`, and presses rows and buttons at their centre like `sim/checks.sh`.

`sim/progress.sh` generates the 300-workout fixture, copies it into the app's data container and relaunches svett on it at the largest text size. It checks the Progress tab shows 300 workouts, then opens each chart screen through its link: `svett://progress/exercise/<exercise id>?range=all` for bench press, `svett://progress/muscles?week=2026-10-26` for the fixture's last full week, and `svett://progress/measurements?kind=body_weight&range=all`, then the same with `&sheet=open` for the add sheet. It shoots each screen a page at a time until the screen's closing rule is on screen, and fails when a chart was on none of the pages. Screenshots go to `out-dir`, by default `~/svett-proof/<branch>/progress/`. It takes `SVETT_DEVICE_CMD`, `SVETT_METRO` and `--release` like `sim/tabs.sh`.

`sim/coach.sh` runs the Swift tests too, then copies the 300-workout fixture and the coach's stand-in fixtures into the app's data container. At the largest text size it relaunches svett once per state and asks through `svett://coach?ask=...`: signed out, no plan usage, "What was my best squat set last month?" answered by `-svettCoachStub` from `packages/tools/fixtures/coach-best-squat.json` while the read tools run on the fixture, and the plan's limit from `coach-plan-limit.json`. It fails when the answer, the data it read or the plan's wording does not show. `--live` asks OpenAI with a real account and `-svettCoachRecord`, signing in first when needed, and saves the exchange as `coach-live.json` in `out-dir`, by default `~/svett-proof/<branch>/coach/`. Copied over `coach-best-squat.json`, it becomes the stand-in that `pnpm test` replays. `pnpm coach-stand-in` rebuilds both stand-ins from OpenAI's documented stream events.

Agents must use these scripts for simulator proof, so anyone can rerun it.

`apps/mobile/ios` is generated by `scripts/ios-prebuild.sh` and is never committed. Change native settings in `apps/mobile/app.config.ts`.

The app icon is rendered from `assets/icon.svg` with `pnpm icon`. Commit the regenerated `apps/mobile/assets/icon.png`.

### Releases

The release job in `.github/workflows/ci.yml` runs after each merge to `main`. `scripts/build-ipa.sh` builds the Release app for devices, signs the app and each app extension ad hoc with its own target's entitlements file, and writes `build/release/svett.ipa`. `scripts/signing-entitlements.ts` fills in build variables such as `$(PRODUCT_BUNDLE_IDENTIFIER)` first and refuses `aps-environment`, and the build checks the signed app has no push entitlement. Push needs a paid Apple account, so svett uses local notifications only. It runs on rena-devbook too, from a full clone. `scripts/publish-release.sh` then creates the GitHub release `v<version>` with `svett.ipa` and `altstore.json`, which `scripts/altstore-source.ts` writes from every published release and from the permissions inside the built app. Change the major and minor version in `apps/mobile/app.config.ts`. The commit count on `main` is the rest, unless `SVETT_BUILD_NUMBER` is set for `scripts/build-ipa.sh`.

### Simulator scripts inside T3 Code

An agent in T3 Code must drive the simulator through the command that T3's `device_open` tool returns, never through `simctl launch`, `simctl openurl` or its own `agent-device` session. The scripts follow that rule when `SVETT_DEVICE_CMD` holds the command. They still build with `xcodebuild` and install with `simctl install`. Without the variable they behave as before, for use outside T3.

1. Call `device_list` for rena-devbook and find `svett iPhone 16 Pro Max` on iOS 27. If it is missing, create it with `xcrun simctl create "svett iPhone 16 Pro Max" "iPhone 16 Pro Max" <iOS 27 runtime>` and list again. To use another iOS 27 simulator instead, set `SVETT_SIMULATOR` to its exact name. The scripts install on that simulator, so it must be the one you open.
2. Call `device_open` with its `hostId` and `id`.
3. Run the scripts with the returned command in `SVETT_DEVICE_CMD`, in the same shell command, because environment variables do not carry over between an agent's shell calls:

   ```sh
   export SVETT_DEVICE_CMD='<the command device_open returned>'
   ~/svett-app/scripts/devbook-build.sh <branch> && ~/svett-app/scripts/sim/tabs.sh
   ```

   `sim/launch.sh` takes the same variable, so `~/svett-app/scripts/sim/launch.sh -svettFixture <path>` relaunches with a fixture.

4. Call `device_close` when done. With `SVETT_DEVICE_CMD` set, `tabs.sh` does not close the session itself.

## Effect and data patterns

The data layer lives in `packages/core`. Follow these patterns so every table stays ready for export, import and sync.

**Schemas.** Every table has one Effect Schema in `packages/core/src/schema.ts`. Its keys are camelCase, and each key's SQL column is the snake_case form. Spread `rowFields(SomeId)` into it, so the row has `id`, `updatedAt` and `deletedAt`. Give each table its own branded ID (`ActivityId`, `ExerciseId`). Write enums as `Schema.Literals`. Put a rule that spans fields in `.check(Schema.makeFilter(...))`, as `ActivitySet` does for "a set records reps, a time or a distance". Rows are checked against the schema on every write and parsed on every read.

**Tables and migrations.** A new table needs its schema, an entry in `TABLES` in `packages/core/src/table.ts`, and a new migration at the end of `MIGRATIONS` in `packages/core/src/migrations.ts`. Never edit a released migration. Never add SQL `CHECK` constraints for enums, or foreign keys. SQLite can only remove them by rebuilding the table, and sync may deliver a child before its parent. The migration test fails until the table's columns match its schema.

**Repositories.** Only a repository writes its tables. Screens and features never run SQL. Each repository is a `Context.Service` in `packages/core/src/repositories/` with a `layer` built by `Layer.effect`. It captures `Sql` and `Ids` and returns plain methods built from `insertRows`, `selectRows`, `updateRow` and `softDeleteRows` in `table.ts`. Wrap a write that touches several rows in `sql.transaction`. Deletes are soft. Deleting a parent deletes its children with the same `deleted_at`, and a restore brings back exactly the rows with that time. Reads never return deleted rows.

**IDs and time.** A new row's ID comes from its `Origin`. Rows made in svett get a UUIDv7 from the `Ids` service. Imported rows get a UUIDv5 of their source and source identity through `importedId`, and their children add a path such as `/exercise/0/set/2`. Library exercises use `libraryExerciseId`. Read time from Effect's `Clock`, never `Date.now()`, and never use `Math.random()` for IDs.

**Databases.** `databaseLayer(driver, ids)` migrates, seeds the exercise library and provides every repository. Each owner has its own file, named by `databaseFileName`. The app opens it with expo-sqlite in `apps/mobile/src/data/database.ts`.

**Tests.** Tests run on `node:sqlite` in memory. `openTestDatabase()` in `packages/core/src/test-database.ts` returns a migrated, seeded database with a manual clock and seeded IDs. Test through the repositories and assert what a caller sees. Read the SQLite file directly only to check what a repository cannot show, such as deleted rows.

**Progress.** Records, chart series, weekly sets per muscle and measurement summaries are pure functions over `PerformedSet` rows, in `records.ts`, `exercise-progress.ts`, `muscle-volume.ts` and `body-measurements.ts`. `ProgressRepository` reads those rows in workout order and writes nothing. Each number comes with the rule the app shows beside it, such as `RECORDS_RULE` and `MUSCLE_SET_RULE`. Change the rule text when the counting changes.

**Fixture.** `pnpm fixture` writes `.fixtures/svett-fixture.db` with 300 strength workouts, about 6,000 sets over two years, three routines and body measurements. The same seed always gives the same rows. To prove it in the simulator, run `scripts/sim/fixture.sh` on rena-devbook after `devbook-build.sh`, with the same `--release` choice and `SVETT_DEVICE_CMD` as `tabs.sh`:

```sh
~/svett-app/scripts/sim/fixture.sh [--release] <out-dir>
```

It generates the fixture into `<out-dir>`, copies it into the app's data container, and screenshots the Progress tab's counts twice. `01-anonymous.png` is a plain launch. `02-fixture.png` is a relaunch through `launch.sh` with `-svettFixture <absolute path>`.

iOS turns `-key value` launch arguments into user defaults, which React Native's `Settings` module reads, so the switch needs no native code. Without it the app opens the anonymous database. The Progress tab shows the counts it read.

## Coach

The coach sends `POST https://api.openai.com/v1/responses` from Swift, in `CoachClient` in `ChatGPTCore`, with the ChatGPT sign-in's token. JavaScript builds each request body and gets back only `CoachEvent`s: text deltas, tool calls, and `done` or `failed`. No token reaches JavaScript.

`askCoach` in `packages/tools` runs one question: it builds the request, checks it with `checkResponsesRequest` against OpenAI's plan usage rules, runs the tool calls and keeps every turn in `coach_message`. It never resends a failed request. Read tools are in `packages/tools/src/tools.ts`, each with an Effect Schema input and output, a bounded answer and a `source` that the answer shows under "Read:". Add a tool there, and it goes to the model in the `svett` namespace. `COACH_METHOD` switches between tool calls, which ship, and the plan's summary fallback.

The tests replay `packages/tools/fixtures/*.json` on the generated database and check every request against the recording. A live run with `scripts/sim/coach.sh --live` records a new one.

## Design system

Screens build on the components in `apps/mobile/src/ui` and the tokens in `apps/mobile/src/design`. The design gallery on the You tab shows each one in its states.

**Colours.** svett is dark only, whatever the phone's appearance setting, so `app.config.ts` sets `userInterfaceStyle: "dark"`. `apps/mobile/global.css` defines every colour token once. Use them as classes, such as `bg-surface` or `text-secondary-label`. Props that take a colour instead of a class, such as an SF Symbol's tint or an SVG stroke, get the current value from `useColor(token)`. A new token goes in `global.css` and in `COLOR_TOKENS` in `tokens.ts`. `tokens.test.ts` fails until both lists match and every pairing the components use passes WCAG AA contrast. Set types and sports map to their colours through `SET_TYPE_COLOR` and `SPORTS`.

**Text.** Use `AppText` with a `variant` named after an iOS text style, such as `body` or `headline`, and a `tone` for its colour. Each variant passes its own `dynamicTypeRamp`, so text scales with Dynamic Type on Apple's curve. Do not cap text size, except on keypad and stepper digits.

**Large text.** Nothing may clip at the largest accessibility text size. `useIsAccessibilityTextSize()` is true at the five accessibility sizes, and layouts that put things side by side stack them there, as `ListRow` and `SetRow` do. Native segments do not grow with text, so `SegmentedControl` shows its options as rows there. Run `scripts/sim/gallery.sh` to check.

**Controls.** Every control has an accessibility role and label, and a target of at least 44 points (`min-h-target`). Controls used mid-set, such as the keypad and stepper, use the larger `key` size. Native controls come from `@expo/ui` where one fits, such as the segmented control and the sheet.

**Runtime.** The app runs on the Hermes that React Native 0.88.1 pins, which lacks some newer JavaScript, such as `Array.prototype.toSorted`, `Temporal`, `Uint8Array`'s base64 methods and every `Intl` formatter but `Collator`, `DateTimeFormat` and `NumberFormat`. Tests run on Node, which has them, so code can pass every test and still throw on the phone. Lint refuses the missing APIs in app code; the list and how to recheck it after a Hermes bump are in `vite.config.ts`.

**Logic.** Components show values and report presses. Formatting and input rules live in `packages/core` with tests, such as `setBadge`, `editNumberEntry` and `niceTicks`.
