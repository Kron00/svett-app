<img src="assets/icon.svg" width="64" height="64" alt="">

# svett.app

svett is an iPhone app for lifting and cardio, with one history for every kind of workout. It works offline, exports all your data, and runs its coach on your own ChatGPT plan. It needs iOS 27 or later.

## Develop

Two machines share the work.

- A Linux machine runs the agents, package installs, lint, type checks and unit tests.
- A Mac runs the native iOS build, the Metro dev server and the iPhone 16 Pro Max simulator.

On the Linux machine, with Node 26 and pnpm 12:

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

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

## License

MIT. See [LICENSE](LICENSE).

Created in [T3 Code](https://t3.codes).
