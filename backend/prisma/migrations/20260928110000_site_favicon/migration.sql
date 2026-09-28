-- Admin-configurable browser-tab icon.
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "faviconUrl" TEXT;
