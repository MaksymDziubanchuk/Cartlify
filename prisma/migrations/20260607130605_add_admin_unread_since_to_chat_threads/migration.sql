-- AlterTable
ALTER TABLE "chat_threads" ADD COLUMN     "adminUnreadSince" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "chat_threads_status_adminUnreadSince_idx" ON "chat_threads"("status", "adminUnreadSince");
