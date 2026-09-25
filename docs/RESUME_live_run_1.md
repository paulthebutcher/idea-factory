# Resume note: live_run_1 (paused 2026-09-25 14:07 UTC)

Paused on Paul's instruction before an internet outage. No run process is running. Nothing partial was
recorded: every stage_result row is a finished stage call (verdict pass, kill, complete, fail_evidence or
error). Claimed-but-unfinished tasks and errored tasks were released back to open so a resume picks up
only remaining work.

## Where each run was

| Run | Stage | Done | Remaining | Spend (model, in runs.spent_usd) |
|---|---|---|---|---|
| live_run_1 | viability (kill gate finished) | kill gate 49 of 50 (43 pass, 6 kill); viability 13 complete | kill gate: P10. viability: 30 tasks (see below) | $5.8 plus about $1.50 of live search not counted in that figure |
| live_run_2, 3, 4 | never started | | | $0 |

Kill gate open: P10
Viability complete: A18,A17,A20,A19,B03,B01,B04,B02,B05,B06,B07,B09,B10
Viability open: A01,A02,A03,A04,A05,A06,A07,A08,A09,A10,A11,A12,A13,A14,A15,A16,H02,H04,O01,O02,O03,O04,O05,P01,P02,P03,P04,P05,P09,P11

Budget: Paul confirmed RUN_BUDGET_USD 30 for the whole live run. Remaining for the resume: 30 minus the
spend above (about $22.70 including the uncounted search spend).

## Why it stopped

1. The Mac slept overnight; on each wake a burst of connection errors failed P10 (kill gate) and 16
   viability tasks. 2. The Anthropic account ran out of credits at 13:43 UTC on 2026-09-25 and 13 more
   viability tasks failed. Credits must be topped up before resuming.

## How to resume (remaining tasks only, nothing re-run)

All with the machine kept awake, SEARCH_MODE=record MODEL_MODE=record and
FIXTURE_DIR=src/search/fixtures/live/run1 so the live run stays replayable:

1. Kill gate then viability for P10:
   `npx tsx src/runner/run.ts --id live_run_2 --stages kill_gate,viability --ideas P10 --budget 1 --concurrency 2`
2. Viability for the open list above (latest kill gate pass, no complete viability yet):
   `npx tsx src/runner/run.ts --id live_run_3 --stages viability --ideas <viability open list> --budget <remaining> --concurrency 4`
   (createRun with stages viability only makes viability tasks for ideas whose latest kill gate is pass.)
3. Critic once over every active idea whose latest viability is complete:
   `npx tsx src/runner/run.ts --id live_run_4 --stages critic --ideas <all completes> --budget <remaining> --concurrency 4`
4. Then `npx tsx scripts/report_run.ts --run live_run_4`, `npm run report:calibration`,
   `npm run export:traces`, `npm run render`, and the Checkpoint 2 report.

live_run_1 itself stays paused as the record of the first pass; its open tasks are superseded by runs 2 and 3.
