-- Tutorial videos (YouTube) per manual page, optionally pinned to a step.
CREATE TABLE IF NOT EXISTS "page_videos" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "stepId" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "youtubeId" VARCHAR(11) NOT NULL,
    "startSec" INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "page_videos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "page_videos_pageId_order_idx" ON "page_videos"("pageId", "order");
CREATE INDEX IF NOT EXISTS "page_videos_stepId_idx" ON "page_videos"("stepId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'page_videos_pageId_fkey') THEN
    ALTER TABLE "page_videos" ADD CONSTRAINT "page_videos_pageId_fkey"
      FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'page_videos_stepId_fkey') THEN
    ALTER TABLE "page_videos" ADD CONSTRAINT "page_videos_stepId_fkey"
      FOREIGN KEY ("stepId") REFERENCES "tutorial_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Playback of a tutorial video on the public manual.
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'VIDEO_PLAY';
