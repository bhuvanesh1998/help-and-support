-- Version history for narration lines, so an edit no longer discards the
-- recording made from the previous wording.

CREATE TABLE "voiceover_segment_versions" (
    "id" UUID NOT NULL,
    "scriptId" UUID NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'generated',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voiceover_segment_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "voiceover_segment_versions_scriptId_segmentIndex_version_key"
    ON "voiceover_segment_versions"("scriptId", "segmentIndex", "version");
CREATE INDEX "voiceover_segment_versions_scriptId_segmentIndex_idx"
    ON "voiceover_segment_versions"("scriptId", "segmentIndex");
ALTER TABLE "voiceover_segment_versions" ADD CONSTRAINT "voiceover_segment_versions_scriptId_fkey"
    FOREIGN KEY ("scriptId") REFERENCES "voiceover_scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Which stored version each line currently holds.
ALTER TABLE "voiceover_segments" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- Clips are now filed per version, so several recordings of one line coexist.
ALTER TABLE "voiceover_audio" ADD COLUMN "segmentVersion" INTEGER NOT NULL DEFAULT 1;
-- The stitched track is derived, not spoken from a version: park it at 0 so it
-- never collides with a line's versions.
UPDATE "voiceover_audio" SET "segmentVersion" = 0 WHERE "kind" = 'timeline';

DROP INDEX IF EXISTS "voiceover_audio_scriptId_segmentIndex_key";
CREATE UNIQUE INDEX "voiceover_audio_scriptId_segmentIndex_segmentVersion_key"
    ON "voiceover_audio"("scriptId", "segmentIndex", "segmentVersion");

-- Backfill: every existing line becomes version 1. Lines that were hand-edited
-- are recorded as such; the wording before that edit was not kept and cannot be
-- reconstructed, so history for those starts here.
INSERT INTO "voiceover_segment_versions"
    ("id", "scriptId", "segmentIndex", "version", "text", "wordCount", "source", "createdAt")
SELECT gen_random_uuid(), "scriptId", "index", 1, "script", "wordCount",
       CASE WHEN "editedAt" IS NULL THEN 'generated' ELSE 'edited' END,
       COALESCE("editedAt", "createdAt")
FROM "voiceover_segments";
