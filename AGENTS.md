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
~/svett-app/scripts/sim/history.sh [--release] [out-dir]          # History proof on the 300-workout fixture
~/svett-app/scripts/sim/data.sh [--release] [out-dir]             # Export, wipe, import, import again and undo
~/svett-app/scripts/sim/coach.sh [--release] [out-dir]            # Swift tests, then the coach's states and answer on the stand-in
~/svett-app/scripts/sim/coach.sh --live [--release] [out-dir]     # Ask OpenAI with a real account and record the exchange
~/svett-app/scripts/sim/routines.sh [--release] [out-dir]         # Build a routine, start it, and time a cold start to the Train tab
~/svett-app/scripts/sim/logger.sh [--release] [out-dir]           # Log a routine and an empty workout, kill svett mid-workout, check the database
~/svett-app/scripts/sim/hevy.sh [--release] [out-dir]             # Hevy import, name match, repeat, changes and undo
~/svett-app/scripts/sim/tools.sh [--release] [out-dir]            # Pounds, the rest notification in the background, a superset, a rest kept through a kill, and the plate calculator
~/svett-app/scripts/sim/signin.sh [--release] [out-dir]           # Sign in, move the phone's data, and check a second account sees none
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

`sim/history.sh` proves the Progress screens on the 300-workout fixture at the largest text size. It generates the fixture, copies it into the app's data container and relaunches on it. It scrolls the history list until the oldest workout's row is on screen, and fails when a screen shows no row or after 600 screens. It opens the newest workout through `svett://workout/<id>`, edits its first normal set through `svett://workout/<id>/set/<set id>` to 222.5 kg on the keypad, and fails unless the detail shows the new weight. Then it saves the workout as a routine, deletes it, checks the count reads 299, presses Undo and checks it reads 300 again. Last it opens `svett://calendar?month=2026-10`. Numbered screenshots go to `out-dir`, by default `~/svett-proof/<branch>/history/`. It takes `SVETT_DEVICE_CMD`, `SVETT_METRO` and `--release` like `sim/tabs.sh`, and presses screen content at an element's centre like `sim/checks.sh`. `svett://progress` opens the Progress tab.

`sim/coach.sh` runs the Swift tests too, then copies the 300-workout fixture and the coach's stand-in fixtures into the app's data container. At the largest text size it relaunches svett once per state and asks through `svett://coach?ask=...`: signed out, no plan usage, "What was my best squat set last month?" answered by `-svettCoachStub` from `packages/tools/fixtures/coach-best-squat.json` while the read tools run on the fixture, and the plan's limit from `coach-plan-limit.json`. It fails when the answer, the data it read or the plan's wording does not show. `--live` asks OpenAI with a real account and `-svettCoachRecord`, signing in first when needed, and saves the exchange as `coach-live.json` in `out-dir`, by default `~/svett-proof/<branch>/coach/`. Copied over `coach-best-squat.json`, it becomes the stand-in that `pnpm test` replays. `pnpm coach-stand-in` rebuilds both stand-ins from OpenAI's documented stream events.
`sim/routines.sh` proves routines at the largest text size, on the 300-workout fixture. It generates the fixture and copies it into the app's data container as `sim/progress.sh` does, and every relaunch opens it. Set `SVETT_FIXTURE` to a fixture's path already in the data container to use that one instead. It discards a workout an earlier run left in progress and goes back to the Train tab. It opens `svett://routines/new` with a name unique to the run, adds Barbell Squat through `svett://routines/new/exercises?q=barbell%20squat`, types 60 kg for 8 to 12 reps on the keypad and adds two sets that copy it. It saves, relaunches, opens the routine from the Train tab and starts it. It checks the workout in progress holds all three sets with that target, and that the Train tab shows the workout. It fails when a screen, the exercise, a target or a set is missing. `SVETT_ROUTINE_NAME` sets the name. It saves `cold-start.txt` with four lines. The first is the time from a relaunch until the Train tab lists the routines, an upper bound because it includes agent-device's calls. The second times the same calls against the running app, the automation's own share. The third is their difference. The fourth is the time svett measured itself, which the Train tab shows when the app is launched with `-svettTiming 1`. It runs from the kernel's start of the process to the first frame with the routine list, leaves out the wait for the `svett://train` link, and lists each step on the way, such as the database open and the routines read. Only a Release build's time counts against the plan's 2 second target. Numbered screenshots go to `out-dir`, by default `~/svett-proof/<branch>/routines/`. It takes `SVETT_DEVICE_CMD`, `SVETT_METRO` and `--release` like `sim/tabs.sh`, and presses at an element's centre like `sim/checks.sh`.

`sim/logger.sh` proves the logger at the largest text size, on a fresh copy of the 300-workout fixture in the app's data container, `Documents/svett-logger.db`. It launches with `-svettTiming 1`, which makes the workout screen show how long the last set took to show done. It starts the fixture's Legs routine, types sets on the keypad, changes a set type, adds a set, moves an exercise, and adds Plank through `svett://train/workout/exercises?q=plank`. Then it kills svett with `xcrun simctl terminate`, launches it again, opens the workout from the bar above the tabs and checks every set came back. It finishes the workout, starts an empty one from the Train tab, and marks a set done that takes last time's values. After the restore and after each finish it copies the database file with its write-ahead log and checks the workout's rows with `node scripts/workout-rows.ts`. It saves the time a set took to show done as `set-done.txt`. Only a Release build's time counts against the 100 millisecond target. It fails when a screen, a set, a value or a row is missing. Numbered screenshots go to `out-dir`, by default `~/svett-proof/<branch>/logger/`. It takes `SVETT_DEVICE_CMD`, `SVETT_METRO` and `--release` like `sim/tabs.sh`. It needs the simulator's UDID for `simctl`, which only finds the data container and kills svett.

`sim/tools.sh` proves the logger tools at the largest text size, on a fresh copy of the 300-workout fixture in `Documents/svett-tools.db`. It grants notifications ahead, switches weights to pounds through `svett://settings/workout`, starts an empty workout and adds Barbell Squat and Romanian Deadlift. It sets the squat's rest to 0:30 from the exercise's options, types 225 lb for 5 and marks the set done. In the very next call it goes to the Home Screen, before any screenshot or database check, and waits on SpringBoard for the "Rest is over" notification. It relaunches, checks the set reads done and the database holds 225 lb in kilograms, joins the two exercises in a superset, and checks the squat's warm-up starts no rest and a Romanian Deadlift set does. It kills and relaunches svett during that rest and checks the rest timer is back. It opens the plate calculator from the options for 225 lb, then `svett://tools/plates?kg=100` for the nearest loads, and finishes the workout. It presses only controls clear of the screen's bottom edge, so it never presses the keypad's Next and Done or the rest timer's buttons. Numbered screenshots go to `out-dir`, by default `~/svett-proof/<branch>/tools/`. It takes `SVETT_DEVICE_CMD`, `SVETT_METRO` and `--release` like `sim/tabs.sh`.

`sim/signin.sh` proves the account sign-in. It needs a build made with `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` set to a Clerk development instance's publishable key, and fails with a message on a build without one. It stops svett, resets the simulator's Keychain, which drops any Clerk session, and puts `pnpm fixture --imported` in the database with no owner, after removing the account databases and the saved answer to the move offer. At the largest text size it shows the 300 imported workouts, opens Account through `svett://account`, shows both choices, and signs in with email as a new account. It moves the phone's data into it and checks the account shows all 300 workouts. Then it signs out, checks nothing is left without an owner, signs in as a second account, and checks it gets no second offer and shows none of the history. The accounts are Clerk test addresses (`+clerk_test`), whose code is always 424242, so no email is read. `SVETT_SIGNIN_EMAILS` overrides the two addresses. Numbered screenshots go to `out-dir`, by default `~/svett-proof/<branch>/signin/`. It takes `SVETT_DEVICE_CMD`, `SVETT_METRO` and `--release` like `sim/tabs.sh`. It fills a field at its centre, then drags once, which closes the keyboard so it covers no button.

Agents must use these scripts for simulator proof, so anyone can rerun it.

`apps/mobile/ios` is generated by `scripts/ios-prebuild.sh` and is never committed. Change native settings in `apps/mobile/app.config.ts`.

The app icon is rendered from `assets/icon.svg` with `pnpm icon`. Commit the regenerated `apps/mobile/assets/icon.png`.

### Releases

The release job in `.github/workflows/ci.yml` runs after each merge to `main`. `scripts/build-ipa.sh` builds the Release app for devices, signs the app and each app extension ad hoc with its own target's entitlements file, and writes `build/release/svett.ipa`. `scripts/signing-entitlements.ts` fills in build variables such as `$(PRODUCT_BUNDLE_IDENTIFIER)` first and refuses `aps-environment`, and the build checks the signed app has no push entitlement. Push needs a paid Apple account, so svett uses local notifications only. It runs on rena-devbook too, from a full clone. `scripts/publish-release.sh` then creates the GitHub release `v<version>` with `svett.ipa` and `altstore.json`, which `scripts/altstore-source.ts` writes from every published release and from the permissions inside the built app. Change the major and minor version in `apps/mobile/app.config.ts`. The commit count on `main` is the rest, unless `SVETT_BUILD_NUMBER` is set for `scripts/build-ipa.sh`.

### Server

`apps/server` is the phase 6 server, one Effect service on Node with PostgreSQL. Node runs its TypeScript directly, as it does the scripts. The root `Dockerfile` builds it. Coolify deploys that image as `svett-app` at `https://svett-app.jservers.net`, with the PostgreSQL database `svett-app-db`, whose address Coolify sets in `DATABASE_URL`. Run `jservers status`, `jservers logs` or `jservers deploys` from the repo to look at it.

`GET /health` answers `{"status":"ok","database":"ok","latestBackup":"<time>","restoreCheck":{...}}`. It answers 503 with `"database":"unreachable"` when the database does not answer. `restoreCheck` shows the newest backup the server restored to prove it works, when it did, whether it `restored`, and how many `tables` came back. It is `null` until the first check since the server started.

Accounts use Clerk. The server checks the Clerk session token in each request's `Authorization: Bearer` header against the instance's published keys, and takes the account from it. `GET /v1/me` names the signed-in account. `GET /v1/rows` lists its rows and `PUT /v1/rows` writes them, each checked against its table's schema in `packages/core`. Rows are keyed by account, table and ID, so two accounts that hold the same ID each keep their own, and any owner a request names is ignored. A write keeps the newer copy of a row. The server reads `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`. The publishable key names the issuer and its key set. With `NODE_ENV=production` it turns sign-in off without both keys, with keys from different kinds of instances, or with an issuer on this machine, so it never trusts a stand-in. Outside production `CLERK_ISSUER` and `CLERK_JWKS_URL` may name a local issuer instead, as the tests' stand-in in `apps/server/src/test-issuer.ts` does. With sign-in off the server still starts and logs why. `/health` says `"signIn": "unconfigured"`, and every account route answers 503 with `sign_in_unavailable`. A token's `azp` must be one of the origins in `CLERK_AUTHORIZED_PARTIES`, separated by commas. Clerk leaves `azp` out of the iPhone app's tokens, which send no origin, so a token without one is accepted. A token must carry `aud` equal to `CLERK_AUDIENCE` when that is set, and may carry no `aud` when it is not. Clerk's free plan keeps a session 7 days.

Server migrations go at the end of `MIGRATIONS` in `apps/server/src/migrations.ts`, keyed `<id>_<name>`. They run when the server starts. Never edit one that has shipped.

The server backs up its database with `pg_dump` into `BACKUP_DIR`, which is `/backups`, a Coolify volume that outlives each deploy. It takes one on start when the newest is more than a day old, then one every night at 03:00 UTC (`BACKUP_CRON`). It keeps the newest 14 (`BACKUP_KEEP`). A dump gets its `svett-<time>.dump` name only once it is complete, and never replaces a backup that has the name. One backup of a database runs at a time, across every server and the command line, through a PostgreSQL advisory lock. Another one skips and logs why. After each backup, and for the newest one on start, the server restores it into a new, empty scratch database `svett_restore_<tag>_<time>_<random>` on the same PostgreSQL, where `<tag>` stands for the live database, counts the tables, and drops it. Each check has its own, so checks on several servers never meet. A check holds an advisory lock named for its scratch database until it drops it, and gives up and drops it after 6 hours. On start the server drops its own live database's scratch databases more than a day old, which a crash left behind. Advisory locks only reach sessions on the same database, so it never touches another live database's. It takes each one's lock first and skips any that a running check still holds. To take one now, run `node apps/server/src/cli.ts backup` in the container. It fails if another backup is running.

To restore, create an empty database on the same PostgreSQL and run this in the server container:

```sh
RESTORE_DATABASE_URL='<the empty database>' node apps/server/src/cli.ts restore /backups/<file>
```

It refuses a database that already holds a table, so it never merges into live data. Then point `DATABASE_URL` at the restored database with `jservers env set` and restart.

The server tests start PostgreSQL in Docker and run `pg_dump` and `pg_restore` from the same image, so Docker must be running. Both images are `postgres:16-alpine`, the deployed database's version, unless `SVETT_TEST_POSTGRES_IMAGE` or `SVETT_TEST_PG_TOOLS_IMAGE` says otherwise. The Dockerfile installs the client tools of that same major version, because a newer `pg_restore` sends settings an older server refuses. Change the three together.

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

**Export and import.** `TransferRepository` writes a svett file's whole rows with their own IDs, and puts back what an import replaced. Phase 6 sync will apply rows the same way. Besides it, only `copyDatabase` in `packages/core/src/database-move.ts` writes every table, when the phone's data moves into an account. A new table also needs its parent in `PARENT` in `packages/core/src/transfer.ts`, or the type check fails, and the round-trip test in `repositories/transfer.test.ts` fails until it puts a row in the table. A file's version is `SVETT_FILE_VERSION`. Raise it with any change to the file's shape. A file holds every row, deleted ones too, so a deletion survives the round trip. An import only adds or replaces the rows the file holds. It never removes a row the file leaves out. Every import records each record it added or replaced in `import_change`, with the IDs of the rows it wrote and the versions they replaced, and Undo works from those rows. Library exercises share the time `LIBRARY_UPDATED_AT` until edited, so every install holds the same library rows.

**Workouts in progress.** One workout at most is in progress. `ActivityRepository` refuses a start, a restore or an update that would make a second one, with `WorkoutInProgressError`. A workout in progress is not history yet. Every query for history, the calendar, streaks, charts, records, muscle volume, counts or export reads only activities with `status = 'finished'` and sets with `done = 1`. A workout in progress is a draft on the phone that started it, so it is never exported, imported or synced. `withoutDrafts` leaves it and every row below it out of an export. An import skips a record whose workout is in progress in the file or here, and its preview counts it as skipped. Undo never puts a workout back in progress beside another one. It keeps that workout discarded and counts it in `discarded`. A field added to a table after svett files existed goes in `addedFields` in `packages/core/src/transfer.ts` with the value its migration gave older rows, so older files and import journals still read and their fingerprints stay the same. A value the migration worked out from other rows comes from the same rows there, as an exercise's set fields come from its sets.

**Logging a workout.** The rules are pure functions in `packages/core/src/logger.ts`: what an exercise's sets record (`setFields`), last time's set for each set (`matchPrevious`), marking a set done (`markDone`), and what finishing keeps (`finishPlan`). `start-workout.ts` composes them with the repositories. The app's logger in `apps/mobile/src/workout/` saves every change through `ActivityRepository` as it is made, through one queue in `store.ts`, so a killed app reopens the workout as it was. A set edit shows at once and saves behind. Nothing about a workout lives only in React state.

**Hevy import.** Another app's file goes through the same `planImport`, `applyImport` and Undo as a svett file, as an `ImportInput` whose `read` builds its rows from the rows here. `hevyImport` in `packages/core/src/hevy-import.ts` does that for Hevy's workout CSV, which `decodeHevyFile` reads. A Hevy workout's identity is its start time as the file writes it, which has no time zone. A workout whose Hevy content has the same `fingerprint` as when it was imported comes back as it is here, so edits made in svett never show as changes. Hevy's exercise names map to the library through `HEVY_LIBRARY` in `hevy-exercises.ts`. The match screen asks for the rest, and `exercise_alias` remembers each choice. A name kept as new becomes a custom exercise with the ID `hevyExerciseId(name)`. Each imported exercise records what its sets hold, as `setFieldsFromSets` decides, so the logger starts it that way next time.

**IDs and time.** A new row's ID comes from its `Origin`. Rows made in svett get a UUIDv7 from the `Ids` service. Imported rows get a UUIDv5 of their source and source identity through `importedId`, and their children add a path such as `/exercise/0/set/2`. Library exercises use `libraryExerciseId`. Read time from Effect's `Clock`, never `Date.now()`, and never use `Math.random()` for IDs.

**Databases.** `databaseLayer(driver, ids)` migrates, seeds the exercise library and provides every repository. Each owner has its own file, named by `databaseFileName`. The app opens it with expo-sqlite in `apps/mobile/src/data/database.ts`.

**Tests.** Tests run on `node:sqlite` in memory. `openTestDatabase()` in `packages/core/src/test-database.ts` returns a migrated, seeded database with a manual clock and seeded IDs. Test through the repositories and assert what a caller sees. Read the SQLite file directly only to check what a repository cannot show, such as deleted rows.

**Weights.** svett stores kilograms. Pounds are a way to show and type weights, set on the You tab's Units and plates screen, and `weight-unit.ts` is the one place that converts and rounds. A weight field that still reads as the stored weight keeps it exactly, so 225 lb saved again does not drift. Units and RPE live in the phone's user defaults through `apps/mobile/src/settings/store.ts`, because they change how weights show, not what is stored. Your plates and bars are data you made, so they are rows of the `gear` table, one per unit, written by `GearRepository`, and they travel with export and import. A running rest is kept in user defaults by `apps/mobile/src/workout/rest.ts`, so it outlives a killed svett, and is never exported.

**Progress.** Records, chart series, weekly sets per muscle and measurement summaries are pure functions over `PerformedSet` rows, in `records.ts`, `exercise-progress.ts`, `muscle-volume.ts` and `body-measurements.ts`. `ProgressRepository` reads those rows in workout order and writes nothing. Each number comes with the rule the app shows beside it, such as `RECORDS_RULE` and `MUSCLE_SET_RULE`. Change the rule text when the counting changes.

**Fixture.** `pnpm fixture` writes `.fixtures/svett-fixture.db` with 300 strength workouts, about 6,000 sets over two years, three routines and body measurements. The same seed always gives the same rows. To prove it in the simulator, run `scripts/sim/fixture.sh` on rena-devbook after `devbook-build.sh`, with the same `--release` choice and `SVETT_DEVICE_CMD` as `tabs.sh`:

```sh
~/svett-app/scripts/sim/fixture.sh [--release] <out-dir>
```

It generates the fixture into `<out-dir>`, copies it into the app's data container, and screenshots the Progress tab's counts twice. `01-anonymous.png` is a plain launch. `02-fixture.png` is a relaunch through `launch.sh` with `-svettFixture <absolute path>`.

`scripts/sim/hevy.sh` proves the Hevy import with the synthetic samples in `packages/core/test-data`, which follow Hevy's column layout. On a new empty database it imports the sample through `svett://import?file=<name>&kind=hevy`, matches one unknown name, presses Done, opens the sample again and expects nothing new, takes the changed sample's changed and renamed workouts, and undoes that import, checking the database after each step. `summary.txt` and the screenshots go to `<out-dir>`, by default `~/svett-proof/<branch>/hevy/`.

`scripts/sim/data.sh` proves export and import on the fixture. It exports through the share sheet, launches on a new empty database file, imports the export through `svett://import?file=<name>`, and checks the result equals the fixture row for row, deleted rows included, with `scripts/compare-databases.ts`. It imports the same file again and expects nothing new, then undoes the import from Your data. The export, both comparisons, `summary.txt` and the screenshots go to `<out-dir>`, by default `~/svett-proof/<branch>/data/`.

`pnpm fixture --imported` brings the same workouts in as one Hevy import instead, as `sim/signin.sh` uses it.

**Accounts on the phone.** Each owner has its own database file, so one account never reads another's rows. `apps/mobile/src/data/current.ts` holds the open one. A new Clerk session opens its account's database. A session that lapses after 7 days keeps the account's database open, logging goes on into it, and the Account screen says to sign in again to sync. Only Sign out opens the database with no owner. Every screen reads through `appDatabase()` and writes through `write` in `data/store.ts`, and reads again after a switch. A write made for one database refuses once another is open, and so does Undo of a deleted workout, whose offer closes when the account changes. It remembers the last owner and opens that database at launch, so an offline launch still opens the account's data. The first sign-in offers once to move the database with no owner into the account. Moving copies every row with its ID through `copyDatabase` and then deletes the file with no owner. Starting empty leaves it on the phone, and it opens again after sign out. The answer is a journal kept outside every database, through `startMove` and `finishMove` in `packages/core/src/move-journal.ts`. It names the account before the copy starts. Until the file with no owner is deleted, signing out opens an empty database instead of it, which refuses every write, the Account screen says the move is unfinished, and no other account is offered the move. Each launch and each sign-in finishes a move a crash cut short, into the account the journal names. Both sign-in choices are steps of `signInStep` in `packages/core/src/sign-in.ts`. The Account screen opens from the You tab or `svett://account`. A build without `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` has no accounts and says so there.

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
