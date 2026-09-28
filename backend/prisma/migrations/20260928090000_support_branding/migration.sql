-- Site branding, support desk (tickets + replies), SMTP config, widget support toggle.
ALTER TABLE "widget_configs" ADD COLUMN IF NOT EXISTS "supportEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "site_settings" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'default',
    "brandName" TEXT NOT NULL DEFAULT 'HelpAssistant',
    "copyrightText" TEXT NOT NULL DEFAULT '© 2026 Widescreen Digital Solutions. All rights reserved.',
    "creditText" TEXT NOT NULL DEFAULT 'Software Designed & Developed by widescreen.in',
    "creditUrl" TEXT NOT NULL DEFAULT 'https://widescreen.in',
    "logoLightUrl" TEXT,
    "logoDarkUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "site_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "site_settings_name_key" ON "site_settings"("name");

CREATE TABLE IF NOT EXISTS "support_configs" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "slaText" TEXT NOT NULL DEFAULT 'Our support team works 24x7 — every issue is resolved within 24 hours at most.',
    "intro" TEXT NOT NULL DEFAULT '',
    "categories" JSONB NOT NULL,
    "priorities" JSONB NOT NULL,
    "notifyEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "support_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "support_configs_name_key" ON "support_configs"("name");

CREATE TABLE IF NOT EXISTS "smtp_configs" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'default',
    "host" TEXT NOT NULL DEFAULT '',
    "port" INTEGER NOT NULL DEFAULT 587,
    "secure" BOOLEAN NOT NULL DEFAULT false,
    "username" TEXT NOT NULL DEFAULT '',
    "passwordCiphertext" TEXT,
    "passwordIv" TEXT,
    "passwordAuthTag" TEXT,
    "fromName" TEXT NOT NULL DEFAULT '',
    "fromEmail" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "smtp_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "smtp_configs_name_key" ON "smtp_configs"("name");

CREATE TABLE IF NOT EXISTS "tickets" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "categoryId" TEXT NOT NULL,
    "categoryLabel" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'Normal',
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "source" TEXT NOT NULL DEFAULT 'site',
    "status" TEXT NOT NULL DEFAULT 'open',
    "ackSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tickets_number_key" ON "tickets"("number");
CREATE INDEX IF NOT EXISTS "tickets_status_createdAt_idx" ON "tickets"("status", "createdAt");

CREATE TABLE IF NOT EXISTS "ticket_replies" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "message" TEXT NOT NULL,
    "authorId" UUID,
    "authorName" TEXT NOT NULL,
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_replies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ticket_replies_ticketId_createdAt_idx" ON "ticket_replies"("ticketId", "createdAt");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_replies_ticketId_fkey') THEN
    ALTER TABLE "ticket_replies" ADD CONSTRAINT "ticket_replies_ticketId_fkey"
      FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
