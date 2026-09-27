-- Objects that were only ever created with `prisma db push`, so a fresh
-- database built from migrations alone was missing them. Written with
-- IF NOT EXISTS throughout: a no-op on databases that already have them
-- (e.g. ones synced via db push and then baselined), so `migrate deploy`
-- works everywhere without a manual `migrate resolve`.

-- AlterTable
ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "category" TEXT,
ADD COLUMN IF NOT EXISTS "categoryOrder" INTEGER NOT NULL DEFAULT 99;

-- CreateTable
CREATE TABLE IF NOT EXISTS "categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 99,
    "icon" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "api_endpoints" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "query" TEXT,
    "host" TEXT,
    "requestBody" TEXT,
    "status" INTEGER,
    "contentType" TEXT,
    "responseSample" TEXT,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ai_credentials" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyLast4" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    "validatedAt" TIMESTAMP(3),
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "mcp_connectors" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "tokenLast4" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "widget_configs" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'default',
    "launcher" TEXT NOT NULL DEFAULT 'fab',
    "icon" TEXT NOT NULL DEFAULT 'question',
    "label" TEXT NOT NULL DEFAULT 'Need some help?',
    "animation" TEXT NOT NULL DEFAULT 'slide',
    "position" TEXT NOT NULL DEFAULT 'right',
    "color" TEXT NOT NULL DEFAULT '#2e6f6a',
    "theme" TEXT NOT NULL DEFAULT 'auto',
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "widget_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "exports" (
    "id" UUID NOT NULL,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "title" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "filename" TEXT,
    "sizeBytes" INTEGER,
    "error" TEXT,
    "requestedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "api_endpoints_pageId_idx" ON "api_endpoints"("pageId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ai_credentials_provider_key" ON "ai_credentials"("provider");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_connectors_name_key" ON "mcp_connectors"("name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "widget_configs_name_key" ON "widget_configs"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "exports_createdAt_idx" ON "exports"("createdAt");

-- AddForeignKey (Postgres has no ADD CONSTRAINT IF NOT EXISTS)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_endpoints_pageId_fkey') THEN
    ALTER TABLE "api_endpoints" ADD CONSTRAINT "api_endpoints_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
