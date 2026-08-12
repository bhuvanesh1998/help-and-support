-- Persisted voiceover scripts so output survives navigation and restarts.
CREATE TABLE "voiceover_scripts" (
    "id" UUID NOT NULL,
    "videoName" TEXT NOT NULL,
    "appName" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "durationSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "width" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 0,
    "fps" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "wordsPerMinute" INTEGER NOT NULL DEFAULT 150,
    "frameCount" INTEGER NOT NULL DEFAULT 0,
    "totalWords" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voiceover_scripts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "voiceover_segments" (
    "id" UUID NOT NULL,
    "scriptId" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "startSec" DOUBLE PRECISION NOT NULL,
    "endSec" DOUBLE PRECISION NOT NULL,
    "onScreen" TEXT NOT NULL,
    "script" TEXT NOT NULL,
    "wordBudget" INTEGER NOT NULL,
    "wordCount" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voiceover_segments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "voiceover_scripts_createdAt_idx" ON "voiceover_scripts"("createdAt");
CREATE INDEX "voiceover_segments_scriptId_idx" ON "voiceover_segments"("scriptId");
CREATE UNIQUE INDEX "voiceover_segments_scriptId_index_key" ON "voiceover_segments"("scriptId", "index");

ALTER TABLE "voiceover_segments" ADD CONSTRAINT "voiceover_segments_scriptId_fkey"
  FOREIGN KEY ("scriptId") REFERENCES "voiceover_scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
