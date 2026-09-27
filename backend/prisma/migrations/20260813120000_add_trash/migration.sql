-- Deleted records held whole for a retention window, restorable until purged.
CREATE TABLE "trash_items" (
    "id" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL,
    "deletedById" UUID,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trash_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "trash_items_expiresAt_idx" ON "trash_items"("expiresAt");
CREATE INDEX "trash_items_entityType_idx" ON "trash_items"("entityType");
