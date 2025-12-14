-- CreateEnum
CREATE TYPE "ChatStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "ChatType" AS ENUM ('bot', 'admin');

-- CreateTable
CREATE TABLE "chat_threads" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "ChatType" NOT NULL,
    "status" "ChatStatus" NOT NULL DEFAULT 'open',
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessagePreview" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_threads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_threads_userId_status_type_lastMessageAt_idx" ON "chat_threads"("userId", "status", "type", "lastMessageAt");

-- AddForeignKey
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
