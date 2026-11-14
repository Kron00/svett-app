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

## Install with AltStore

svett is not in the App Store. AltStore installs it and offers each new version. The app needs iOS 27 or later.

1. Install AltStore on the iPhone. [altstore.io](https://altstore.io) has the steps. They need a Mac or a PC.
2. In AltStore, open **Sources** and tap **+**.
3. Enter this address and add the source.

   ```
   https://github.com/Kron00/svett-app/releases/latest/download/altstore.json
   ```

4. Open the **svett** source and install **svett**.

With a free Apple account the app stops opening after 7 days unless AltStore refreshes it. Your data stays on the phone.

Every merge to `main` publishes a new version. The release job builds the app on GitHub's macOS runner, signs it ad hoc with the entitlements Expo generates, and attaches `svett.ipa` and `altstore.json` to a GitHub release. The version is the major and minor from `apps/mobile/app.config.ts` plus the commit count on `main`, such as 0.1.37.

Each app extension is signed with its own entitlements, and build variables in them are filled in first. The build fails if anything would be signed with push notifications, which a free Apple account cannot sign. svett only uses local notifications. The release also fails if a newer version is already published, so a late or repeated run never pairs a newer version with older permissions.

### Phone checks

**You > Phone checks** proves what only a phone can: the Keychain after a restart, a notification in the background, GPS with the screen locked, Apple Health permission, and the ChatGPT sign-in. Run each check, type in the App ID and active app counts AltStore shows, and tap **Copy report**. The report never contains a token.

## License

MIT. See [LICENSE](LICENSE).

Created in [T3 Code](https://t3.codes).
