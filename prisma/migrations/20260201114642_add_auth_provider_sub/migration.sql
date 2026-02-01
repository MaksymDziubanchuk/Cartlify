/*
  Warnings:

  - A unique constraint covering the columns `[authProvider,providerSub]` on the table `users` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('LOCAL', 'GOOGLE', 'GITHUB', 'LINKEDIN');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "authProvider" "AuthProvider" NOT NULL DEFAULT 'LOCAL',
ADD COLUMN     "providerSub" TEXT,
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "users_authProvider_idx" ON "users"("authProvider");

-- CreateIndex
CREATE UNIQUE INDEX "users_authProvider_providerSub_key" ON "users"("authProvider", "providerSub");
