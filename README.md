<img src="assets/icon.svg" width="64" height="64" alt="">

# svett.app

svett is an iPhone app for lifting and cardio, with one history for every kind of workout. It works offline, exports all your data, and runs its coach on your own ChatGPT plan. It needs iOS 27 or later.

## Develop

Two machines share the work.

- A Linux machine runs the agents, package installs, lint, type checks and unit tests.
- A Mac runs the native iOS build, the Metro dev server and the iPhone 16 Pro Max simulator.

On the Linux machine, install Node 26 and pnpm 12. `.node-version` and the `packageManager` field in `package.json` pin the exact versions. Then install the packages:

```sh
pnpm install
```

The app reads no environment variables, so there is no `.env` file to create.

| Command          | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `pnpm lint`      | Lints every package.                                     |
| `pnpm fmt`       | Formats every file. `pnpm fmt:check` only reports.       |
| `pnpm typecheck` | Type checks every package.                               |
| `pnpm test`      | Runs every package's tests.                              |
| `pnpm icon`      | Renders `apps/mobile/assets/icon.png` from the SVG icon. |

To prove that the app's JavaScript bundles without a Mac, run:

```sh
pnpm --filter @svett/mobile exec expo export --platform ios
```

### Run the tests

`pnpm test` runs every package's tests. To run one package's tests, or one test file, use a filter:

```sh
pnpm --filter @svett/core test
pnpm --filter @svett/core exec vp test run src/duration.test.ts
```

### Continuous integration

GitHub Actions runs `.github/workflows/ci.yml` on every pull request and on every push to `main`. One job checks the format, lints, type checks, runs the tests and bundles the app. A second job compiles the app for the iOS Simulator on a macOS runner. A pull request into `main` needs both jobs to pass. The repo owner can bypass that rule.

Dependabot checks for updates each week. It groups package updates into one pull request and GitHub Actions updates into another. `.github/dependabot.yml` holds the rules.

### Build on the Mac

On the Mac, with Xcode 27.2, CocoaPods, Node 26 and pnpm 12:

```sh
scripts/devbook-build.sh <branch>            # build, start Metro on localhost:8081, open the app
scripts/devbook-build.sh --release <branch>  # Release build with the JS bundle inside, no Metro
```

The `ios/` folder is generated on each build and never committed. Native settings live in `apps/mobile/app.config.ts`.

## Install

AltStore install steps arrive with the release pipeline in F2.

## License

MIT. See [LICENSE](LICENSE).

Created in [T3 Code](https://t3.codes).
