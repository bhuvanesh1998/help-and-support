-- Customer follow-ups posted from the widget / site ticket tracker.
ALTER TABLE "ticket_replies" ADD COLUMN IF NOT EXISTS "fromCustomer" BOOLEAN NOT NULL DEFAULT false;
