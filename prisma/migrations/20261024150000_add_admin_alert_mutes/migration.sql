-- the kinds of alerts an admin or root turned off; its policies are in db/03
-- CreateTable
CREATE TABLE "admin_alert_mutes" (
    "userId" INTEGER NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_alert_mutes_pkey" PRIMARY KEY ("userId","kind")
);

-- AddForeignKey
ALTER TABLE "admin_alert_mutes" ADD CONSTRAINT "admin_alert_mutes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

