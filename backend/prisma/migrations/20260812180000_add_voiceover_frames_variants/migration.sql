-- Tone variants: a run can re-use another script's frames.
ALTER TABLE "voiceover_scripts" ADD COLUMN "sourceScriptId" UUID;
CREATE INDEX "voiceover_scripts_sourceScriptId_idx" ON "voiceover_scripts"("sourceScriptId");
ALTER TABLE "voiceover_scripts" ADD CONSTRAINT "voiceover_scripts_sourceScriptId_fkey"
  FOREIGN KEY ("sourceScriptId") REFERENCES "voiceover_scripts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Sampled stills, so regeneration needs no re-upload.
CREATE TABLE "voiceover_frames" (
    "id" UUID NOT NULL,
    "scriptId" UUID NOT NULL,
    "at" DOUBLE PRECISION NOT NULL,
    "isSceneChange" BOOLEAN NOT NULL DEFAULT false,
    "imageUrl" TEXT,
    "storagePath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voiceover_frames_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "voiceover_frames_scriptId_idx" ON "voiceover_frames"("scriptId");
ALTER TABLE "voiceover_frames" ADD CONSTRAINT "voiceover_frames_scriptId_fkey"
  FOREIGN KEY ("scriptId") REFERENCES "voiceover_scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
