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

## Install

AltStore install steps arrive with the release pipeline in F2.

## License

MIT. See [LICENSE](LICENSE).

Created in [T3 Code](https://t3.codes).
