-- Per-call usage for the Voiceover Studio, reported in raw units.
CREATE TABLE "voiceover_usage" (
    "id" UUID NOT NULL,
    "scriptId" UUID,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "frames" INTEGER NOT NULL DEFAULT 0,
    "characters" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voiceover_usage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "voiceover_usage_createdAt_idx" ON "voiceover_usage"("createdAt");
CREATE INDEX "voiceover_usage_scriptId_idx" ON "voiceover_usage"("scriptId");
CREATE INDEX "voiceover_usage_provider_kind_idx" ON "voiceover_usage"("provider", "kind");
