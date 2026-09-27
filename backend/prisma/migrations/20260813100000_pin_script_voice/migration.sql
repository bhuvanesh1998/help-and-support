-- The voice a script is narrated in, so re-records match the takes already made
-- instead of following whatever the voice dropdown happened to show.
ALTER TABLE "voiceover_scripts" ADD COLUMN "voiceId" TEXT;
ALTER TABLE "voiceover_scripts" ADD COLUMN "voiceName" TEXT;
ALTER TABLE "voiceover_scripts" ADD COLUMN "ttsModelId" TEXT;

-- Which takes a stitched track was mixed from, so a stale track can say so
-- rather than quietly playing the old wording.
ALTER TABLE "voiceover_audio" ADD COLUMN "sourceSignature" TEXT;

-- Backfill: adopt the voice most of a script's existing takes already use. On the
-- scripts recorded before this column existed that is the intended voice — a
-- stray take in another voice is the bug this column prevents.
UPDATE "voiceover_scripts" s
SET "voiceId" = v."voiceId", "voiceName" = v."voiceName", "ttsModelId" = v."modelId"
FROM (
    SELECT DISTINCT ON ("scriptId")
           "scriptId", "voiceId", "voiceName", "modelId", COUNT(*) AS n
    FROM "voiceover_audio"
    WHERE "kind" = 'segment'
    GROUP BY "scriptId", "voiceId", "voiceName", "modelId"
    ORDER BY "scriptId", n DESC
) v
WHERE s."id" = v."scriptId";
