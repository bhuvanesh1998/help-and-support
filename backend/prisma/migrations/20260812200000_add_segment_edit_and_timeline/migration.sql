-- Manual edits to a generated line.
ALTER TABLE "voiceover_segments" ADD COLUMN "editedAt" TIMESTAMP(3);

-- Distinguish per-line clips from the full-length stitched track.
ALTER TABLE "voiceover_audio" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'segment';
