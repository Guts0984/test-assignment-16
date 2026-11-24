-- A row re-armed while running must run again after the current run finishes.
ALTER TABLE "scheduled_actions" ADD COLUMN "rearmed" BOOLEAN NOT NULL DEFAULT false;
