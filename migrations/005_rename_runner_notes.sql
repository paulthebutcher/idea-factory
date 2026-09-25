-- 005: stage results written before 2026-09-24 stored runner remarks under the key "notes", which
-- collides with the hidden ideas.notes column name and gets scrubbed from exports. Rename the key in
-- stored payloads and trace events. Only runner output ever used this key in these tables.
UPDATE stage_results SET payload_json = replace(payload_json, '"notes":', '"remarks":') WHERE payload_json LIKE '%"notes":%';
UPDATE trace_events SET content_json = replace(content_json, '"notes":', '"remarks":') WHERE content_json LIKE '%"notes":%';
