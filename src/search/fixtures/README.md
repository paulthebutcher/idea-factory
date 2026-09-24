# Recorded fixtures

Search fixtures: `exa/`, `brave/`, `exa_contents/`, one file per `sha256(engine + "\n" + query)`.
Model transcripts: `model/<stage>/<idea>.s<n>.json`, the ordered assistant messages of one stage call.
Critic transcripts: `model/critic/<a>__<b>__<ab|ba>.json` plus `briefs.json` (the blinded inputs).
`archive/` holds superseded transcripts (checkpoint1: original rules; checkpoint1_rerecord: before the T8
baseline rule). `recording_log.jsonl` records every recording session and its live spend.

Record with `npm run record:fixtures -- --stage kill_gate|viability --ideas ... --samples N --cap USD` and
`npm run record:critic -- --ideas ... --cap USD`. Replay is free and deterministic; a missing fixture fails loudly.
