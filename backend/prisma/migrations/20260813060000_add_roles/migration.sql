-- Named permission sets, assignable to admin users.
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "permissions" TEXT[],
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- Nullable: existing accounts keep working on the legacy ADMIN fallback until a
-- role is assigned. SET NULL on delete for the same reason — removing a role
-- must not remove the user.
ALTER TABLE "users" ADD COLUMN "roleId" UUID;
CREATE INDEX "users_roleId_idx" ON "users"("roleId");
ALTER TABLE "users" ADD CONSTRAINT "users_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
