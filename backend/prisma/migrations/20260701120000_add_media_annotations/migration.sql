-- AlterTable
-- Non-destructive annotation editor support for media assets. All additive and
-- nullable, so existing rows are unaffected.
ALTER TABLE "media_assets" ADD COLUMN "annotations" JSONB;
ALTER TABLE "media_assets" ADD COLUMN "originalStoragePath" TEXT;
ALTER TABLE "media_assets" ADD COLUMN "originalUrl" TEXT;
ALTER TABLE "media_assets" ADD COLUMN "editedAt" TIMESTAMP(3);
