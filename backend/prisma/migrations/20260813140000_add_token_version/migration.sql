-- Lets already-issued tokens be invalidated: logout-everywhere and password
-- changes bump this, and a token signed with an older value is rejected.
ALTER TABLE "users" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
