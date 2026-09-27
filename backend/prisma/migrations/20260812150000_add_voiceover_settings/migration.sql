-- Runtime-editable Voiceover Studio settings (single "default" row).
CREATE TABLE "voiceover_settings" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'default',
    "maxVideoUploadMb" INTEGER NOT NULL DEFAULT 500,
    "model" TEXT NOT NULL DEFAULT 'claude-opus-5',
    "effort" TEXT NOT NULL DEFAULT 'medium',
    "maxTokens" INTEGER NOT NULL DEFAULT 12000,
    "maxFrames" INTEGER NOT NULL DEFAULT 48,
    "framesPerBatch" INTEGER NOT NULL DEFAULT 12,
    "frameWidth" INTEGER NOT NULL DEFAULT 960,
    "frameQuality" INTEGER NOT NULL DEFAULT 4,
    "sceneThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "minFrameGapSec" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "minSegmentSec" DOUBLE PRECISION NOT NULL DEFAULT 4,
    "maxSegmentSec" DOUBLE PRECISION NOT NULL DEFAULT 14,
    "wordsPerMinute" INTEGER NOT NULL DEFAULT 150,
    "jobRetentionMinutes" INTEGER NOT NULL DEFAULT 60,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voiceover_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "voiceover_settings_name_key" ON "voiceover_settings"("name");
