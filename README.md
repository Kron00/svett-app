<img src="assets/icon.svg" width="64" height="64" alt="">

# svett.app

svett is an iPhone app for lifting and cardio, with one history for every kind of workout. It works offline, exports all your data, and runs its coach on your own ChatGPT plan. It needs iOS 27 or later.

## Repository

| Path             | Holds                                                                             |
| ---------------- | --------------------------------------------------------------------------------- |
| `apps/mobile`    | The Expo and React Native app.                                                    |
| `packages/core`  | Domain logic in plain TypeScript with no React, and its unit tests.               |
| `packages/tools` | Where the coach's shared tool definitions will live. Empty for now.               |
| `scripts`        | Mac build and simulator scripts, the icon renderer, and the build script's tests. |
| `docs/plan.html` | The approved build plan. Each pull request matches a step in it.                  |

## Develop

Two machines share the work.

- A Linux machine runs the agents, package installs, lint, type checks and unit tests.
- A Mac runs the native iOS build, the Metro dev server and the iPhone 16 Pro Max simulator.

On the Linux machine, with the Node version in `.node-version` and the pnpm version in `package.json`:

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

The app reads no environment variables, so there is no `.env` file to set up.

### Scripts

| Command                                                       | What it does                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm lint`                                                   | Lints every package with Vite+.                                        |
| `pnpm fmt`                                                    | Formats the repo. `pnpm fmt:check` only reports, as CI does.           |
| `pnpm typecheck`                                              | Type checks every package.                                             |
| `pnpm test`                                                   | Runs every package's tests.                                            |
| `pnpm icon`                                                   | Renders `assets/icon.svg` to `apps/mobile/assets/icon.png`.            |
| `pnpm --filter @svett/mobile exec expo export --platform ios` | Bundles the app's JavaScript. It proves the app bundles without a Mac. |

### Tests

`pnpm test` runs the Vitest suites in `packages/core` and the shell tests for `scripts/devbook-build.sh`. Vitest files sit next to the code they test, as `*.test.ts`. The shell tests live in `scripts/test/`. To run one package, or to rerun on each save:

```sh
pnpm --filter @svett/core test
pnpm --filter @svett/core exec vp test watch
```

### CI

GitHub Actions runs `.github/workflows/ci.yml` on every pull request and on each push to `main`. One job checks formatting, lint, types and tests, then bundles the app. The other builds the app for the iOS Simulator on a macOS runner. Changes reach `main` through pull requests, and both jobs must pass first. Admins can still push directly. Dependabot opens one grouped pull request each week for npm packages and one for GitHub Actions.

On the Mac, with Xcode 27.2, CocoaPods, and the same Node and pnpm versions:

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
