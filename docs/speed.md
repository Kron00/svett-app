# Speed targets

The plan sets five speed targets. Each is measured in a Release build on the 300-workout fixture, at the largest text size, on the iPhone 16 Pro Max simulator. Simulator numbers are a floor for regressions. The phone checkpoints are where real speed is judged.

`scripts/sim/speed.sh --release` measures all five and writes the table below as `speed.md` in its out-dir. Run it on the Mac after `scripts/devbook-build.sh --release <branch>`.

| What                                       | How svett measures it                                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold start to a usable Train tab           | `sim/startup.sh` launches 5 times straight into Train with `-svettTiming 1`. svett times each launch from the process start to the first frame with the routine list. The table shows the median.                         |
| Marking a set done, until the row shows it | `sim/logger.sh` marks a set done. svett times the press to the first frame that shows the set done.                                                                                                                       |
| History list of 300 workouts               | `sim/history.sh` scrolls the history from the newest workout to the oldest and fails when any screen shows no row.                                                                                                        |
| Importing 300 workouts from a Hevy file    | `speed.sh` imports a synthetic Hevy export of 300 workouts from `scripts/hevy-export.ts` on a new database. svett times reading and previewing the file, and saving the import, without the wait for the press on Import. |
| First words of a coach answer              | `speed.sh` asks the coach's stand-in question. svett times the first words of the answer from arriving to the first frame that shows them. The target counts as met within 100 milliseconds.                              |

## Measured in X2

The table from the X2 run goes here.
