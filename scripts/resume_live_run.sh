#!/bin/zsh
# Resume the step 8 live run from remaining tasks only (see docs/RESUME_live_run_1.md).
#   run 2: kill gate + viability for ideas whose latest kill gate is error
#   run 3: viability for active ideas whose latest kill gate is pass and latest viability is missing or error
#   run 4: one critic tournament over every active idea whose latest viability is complete
# Overall budget: $30 across all live_run_* runs; $1.50 of early search spend was not counted, so the
# base is 28.5. Stops if a run ends in error (for example exhausted credits).
set -u
cd "$(dirname "$0")/.."
export SEARCH_MODE=record MODEL_MODE=record FIXTURE_DIR="src/search/fixtures/live/run1"
DB=data/factory.db
BASE=28.5
spent() { sqlite3 $DB "select coalesce(round(sum(spent_usd),4),0) from runs where id like 'live_run_%';"; }
remain() { python3 -c "print(max(0, round($BASE - $(spent), 2)))"; }
status() { sqlite3 $DB "select status from runs where id='$1';"; }
latest_kg="select idea_id, verdict from stage_results sr where stage='kill_gate' and rowid=(select rowid from stage_results s2 where s2.idea_id=sr.idea_id and s2.stage='kill_gate' order by created_at desc, rowid desc limit 1)"
latest_via="select idea_id, verdict from stage_results sr where stage='viability' and rowid=(select rowid from stage_results s2 where s2.idea_id=sr.idea_id and s2.stage='viability' order by created_at desc, rowid desc limit 1)"

echo "[$(date +%H:%M:%S)] resume: spent so far \$$(spent), remaining \$$(remain)"

KG_RETRY=$(sqlite3 $DB "with k as ($latest_kg) select group_concat(i.id) from ideas i join k on k.idea_id=i.id where i.status='active' and k.verdict='error';")
if [ -n "$KG_RETRY" ]; then
  echo "[$(date +%H:%M:%S)] run 2: kill_gate,viability for $KG_RETRY"
  npx tsx src/runner/run.ts --id live_run_2 --stages kill_gate,viability --ideas "$KG_RETRY" --budget 1.5 --concurrency 2
  [ "$(status live_run_2)" = "error" ] && { echo "[$(date +%H:%M:%S)] run 2 ended in error; stopping the chain"; exit 1; }
fi

VIA_RETRY=$(sqlite3 $DB "with k as ($latest_kg), v as ($latest_via) select group_concat(i.id) from ideas i join k on k.idea_id=i.id left join v on v.idea_id=i.id where i.status='active' and k.verdict='pass' and (v.verdict is null or v.verdict='error');")
if [ -n "$VIA_RETRY" ]; then
  echo "[$(date +%H:%M:%S)] run 3: viability for $(echo $VIA_RETRY | tr ',' '\n' | wc -l | tr -d ' ') ideas, budget \$$(remain)"
  npx tsx src/runner/run.ts --id live_run_3 --stages viability --ideas "$VIA_RETRY" --budget $(remain) --concurrency 4
  [ "$(status live_run_3)" = "error" ] && { echo "[$(date +%H:%M:%S)] run 3 ended in error; stopping the chain"; exit 1; }
fi

COMPLETES=$(sqlite3 $DB "with v as ($latest_via) select group_concat(i.id) from ideas i join v on v.idea_id=i.id where i.status='active' and v.verdict='complete';")
echo "[$(date +%H:%M:%S)] run 4: critic over $(echo $COMPLETES | tr ',' '\n' | wc -l | tr -d ' ') completes, budget \$$(remain)"
npx tsx src/runner/run.ts --id live_run_4 --stages critic --ideas "$COMPLETES" --budget $(remain) --concurrency 4
echo "[$(date +%H:%M:%S)] chain finished: run 4 status $(status live_run_4), total spent \$$(spent)"
