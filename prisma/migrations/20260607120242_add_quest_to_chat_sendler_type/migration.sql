/*
  Warnings:

  - The values [system] on the enum `ChatMessageSenderType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ChatMessageSenderType_new" AS ENUM ('user', 'admin', 'bot', 'guest');
ALTER TABLE "chat_messages" ALTER COLUMN "senderType" TYPE "ChatMessageSenderType_new" USING ("senderType"::text::"ChatMessageSenderType_new");
ALTER TYPE "ChatMessageSenderType" RENAME TO "ChatMessageSenderType_old";
ALTER TYPE "ChatMessageSenderType_new" RENAME TO "ChatMessageSenderType";
DROP TYPE "cartlify"."ChatMessageSenderType_old";
COMMIT;
