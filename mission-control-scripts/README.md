# Mission Control scripts

Tools for measuring Mission Control runs from the app's database.

## run-report.mjs

A timing and health report for one feature run.

```bash
node mission-control-scripts/run-report.mjs --list
node mission-control-scripts/run-report.mjs <feature-key>
```

It reads a copy of the database, so it's safe while the app is running. By default it reads `~/Library/Application Support/north-star/mission-control.db`. Point it elsewhere with `--db <path>` or the `MC_DB` environment variable.

Times are minutes from when the planning proposal was applied, so time spent reviewing the proposal isn't counted.

| Section | What it shows |
|---|---|
| Summary | Status, drive mode, overlap policy, drive time used, when the work finished, and how long the feature then waited on you. |
| Runs | Every story and hook run: start, duration, outcome. |
| Phases | Time per playbook phase, with failed runs. |
| Failures | Each failed phase's error, grouped. |
| Merges | Conflicts, integrator resolutions, time from proof to merge, and the merge note (for example, which generated files were regenerated). |
| Concurrency | The most user stories that ran at once. |
| Models and tools | Models recorded per phase, output-cap escalations, the most-used tools, and `index_query_tool` calls. |
| Seat messages | Seat-to-seat messages by status, and messages from the Navigator or user. |
| Plan shape | Each milestone's live graph as it ran: steps if overlapping stories wait versus run in parallel, and the overlapping pairs. |

Requires Node 23.6 or later (or 22.18 or later): it uses the built-in `node:sqlite` module and imports the app's scheduling code from `src/shared/mission-control/waves.ts`, so its plan-shape numbers match the in-app estimate.
