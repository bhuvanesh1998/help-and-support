-- AlterTable
-- Publish state for a Page. Additive, non-destructive: existing rows default to
-- live (true) so nothing is hidden by the upgrade. Off (false) hides the manual
-- from the public help center while it stays editable in the admin.
ALTER TABLE "pages" ADD COLUMN "isPublished" BOOLEAN NOT NULL DEFAULT true;
