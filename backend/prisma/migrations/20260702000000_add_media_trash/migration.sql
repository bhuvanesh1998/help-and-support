-- AlterTable
-- Soft-delete (trash) support for media assets. Additive and nullable, so
-- existing rows are unaffected and default to "live" (deletedAt IS NULL).
ALTER TABLE "media_assets" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "media_assets_deletedAt_idx" ON "media_assets"("deletedAt");
