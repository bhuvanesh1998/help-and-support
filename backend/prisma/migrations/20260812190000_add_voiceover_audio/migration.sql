-- Rendered narration audio, one clip per script segment.
CREATE TABLE "voiceover_audio" (
    "id" UUID NOT NULL,
    "scriptId" UUID NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "voiceId" TEXT NOT NULL,
    "voiceName" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "publicUrl" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voiceover_audio_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "voiceover_audio_scriptId_idx" ON "voiceover_audio"("scriptId");
CREATE UNIQUE INDEX "voiceover_audio_scriptId_segmentIndex_key" ON "voiceover_audio"("scriptId", "segmentIndex");
ALTER TABLE "voiceover_audio" ADD CONSTRAINT "voiceover_audio_scriptId_fkey"
  FOREIGN KEY ("scriptId") REFERENCES "voiceover_scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
