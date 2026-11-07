-- Bounty Royale: clearly labelled DEMO teams (sample teams for testing; never official entrants).
ALTER TABLE royale_projects ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
