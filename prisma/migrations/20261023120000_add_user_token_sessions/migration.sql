-- the session a refresh token belongs to (kept across its renewals), the browser that opened it,
-- and the moment a session was closed on purpose, told apart from a renewal; the sessions opened
-- before get a session at their next renewal (db/06 checks the new rows only)

-- AlterTable
ALTER TABLE "user_tokens" ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "sessionId" UUID,
ADD COLUMN     "userAgent" TEXT;

-- CreateIndex
CREATE INDEX "user_tokens_sessionId_idx" ON "user_tokens"("sessionId");
