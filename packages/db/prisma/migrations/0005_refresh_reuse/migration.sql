-- How often a just-rotated refresh token was presented again inside the grace window (capped by the api).
ALTER TABLE "refresh_tokens" ADD COLUMN "reuse_count" INTEGER NOT NULL DEFAULT 0;
