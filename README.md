<img src="assets/icon.svg" width="64" height="64" alt="">

# svett.app

svett is an iPhone app for lifting and cardio. Every workout lands in one feed and one history: a lifting session, a run, a ride, a walk or a hike. It works offline, keeps your data on your phone, and exports all of it as one file you can import again. Its coach runs on your own ChatGPT plan. It needs iOS 27 or later.

The [user guide](docs/guide.md) explains each tab and feature.

## What it does

- **Train.** Log a workout from a routine or from scratch, with warm-up, failure and drop sets, supersets, RPE, notes, last time's values, a rest timer, and plate and warm-up calculators. Record a run, walk, hike or ride with GPS, or enter one by hand.
- **Progress.** History, a calendar with your streak, records, charts for each exercise, weekly sets per muscle, and body measurements. Each number shows the rule behind it.
- **Your data.** Export everything as one file and import it back. Import your Hevy history and Apple Health workouts. Every import shows a preview first, skips what you already have, and can be undone.
- **Coach.** Tap Continue with ChatGPT and ask about your training. It answers from the data on your phone, and any routine it drafts waits for you to apply it.
- **Feed.** An account is optional. With one you can sync between phones, follow people and share workouts, each with its own audience.

## Install with AltStore

svett is not in the App Store. AltStore installs it from this repo's releases and offers each new version.

1. Install AltStore on the iPhone. [altstore.io](https://altstore.io) has the steps. They need a Mac or a PC.
2. In AltStore, open **Sources** and tap **+**.
3. Enter this address and add the source.

   ```
   https://github.com/Kron00/svett-app/releases/latest/download/altstore.json
   ```

4. Open the **svett** source and install **svett**.

With a free Apple account the app stops opening after 7 days unless AltStore refreshes it. Your data stays on the phone across refreshes and updates.

Every merge to `main` publishes a new version on the [releases page](https://github.com/Kron00/svett-app/releases). The release job builds the app on GitHub's macOS runner, signs it ad hoc with the entitlements Expo generates, and attaches `svett.ipa` and `altstore.json` to a GitHub release. The version is the major and minor from `apps/mobile/app.config.ts` plus the commit count on `main`, such as 0.1.37.

Each app extension is signed with its own entitlements, and build variables in them are filled in first. The build fails if anything would be signed with push notifications, which a free Apple account cannot sign. svett only uses local notifications. The release also fails if a newer version is already published, so a late or repeated run never pairs a newer version with older permissions.

## Build and run

Two machines share the work.

- A Linux machine runs the package installs, lint, type checks and unit tests.
- A Mac runs the native iOS build, the Metro dev server and the iPhone 16 Pro Max simulator.

On the Linux machine, with Node 26 and pnpm 12 (both pinned in the repo):

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm fmt
```

On the Mac, with Xcode 27.2, CocoaPods, Node 26 and pnpm 12:

```sh
scripts/devbook-build.sh <branch>            # build, start Metro on localhost:8081, open the app
scripts/devbook-build.sh --release <branch>  # Release build with the JS bundle inside, no Metro
scripts/sim/walkthrough.sh --release         # record every tab at the default and the largest text size
scripts/sim/speed.sh --release               # measure the speed targets and write speed.md
```

The `ios/` folder is generated on each build and never committed. Native settings live in `apps/mobile/app.config.ts`. `pnpm fixture` writes a database of 300 workouts for trying the app with real-looking data. [AGENTS.md](AGENTS.md) lists every script and the rules the code keeps.

### Phone checks

**You > Phone checks** proves what only a phone can: the Keychain after a restart, a notification in the background, GPS with the screen locked, Apple Health permission, and the ChatGPT sign-in. Run each check, type in the App ID and active app counts AltStore shows, and tap **Copy report**. The report never contains a token.

## Repo layout

| Path             | Holds                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile`    | The Expo app. `src/` holds the screens, `src/ui` the components, `modules/` the Swift modules.                               |
| `apps/server`    | The server for accounts, sync and the feed: one Effect service on Node with PostgreSQL.                                      |
| `packages/core`  | Pure TypeScript with no React: schemas, repositories, import parsers, records, charts, the sync merge and the privacy rules. |
| `packages/tools` | The assistant tool definitions the coach and the ChatGPT connector share.                                                    |
| `scripts`        | Builds, releases, the AltStore source, the fixture and the simulator proof scripts in `scripts/sim`.                         |
| `docs`           | The [build plan](docs/plan.html), the [user guide](docs/guide.md) and the [speed targets](docs/speed.md).                    |
| `research`       | The Hevy and Strava feature inventory the plan is based on.                                                                  |

## For contributors

[AGENTS.md](AGENTS.md) is the guide for anyone changing the code, people and agents alike. It covers the data patterns, the design system and every script. [docs/plan.html](docs/plan.html) is the approved build plan, with each pull request, its proof and the rules the code keeps.

## License

MIT. See [LICENSE](LICENSE).

Created in [T3 Code](https://t3.codes).
