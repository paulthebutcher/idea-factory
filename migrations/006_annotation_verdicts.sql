-- Review app annotations (viewer/). An annotation targets a stage result or a comparison, carries an
-- agree | disagree | unsure verdict, and records whether Paul made it blind (hidden fields not revealed).
ALTER TABLE annotations ADD COLUMN comparison_id INTEGER REFERENCES comparisons(id);
ALTER TABLE annotations ADD COLUMN verdict TEXT;          -- agree | disagree | unsure | NULL (note only)
ALTER TABLE annotations ADD COLUMN blind INTEGER NOT NULL DEFAULT 1;  -- 1 when hidden fields were not revealed for the idea
