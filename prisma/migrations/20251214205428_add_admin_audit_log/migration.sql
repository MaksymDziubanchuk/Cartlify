-- CreateEnum
CREATE TYPE "AdminAuditEntityType" AS ENUM ('user', 'product', 'category', 'order', 'review', 'other');

-- CreateEnum
CREATE TYPE "AdminAuditAction" AS ENUM ('USER_ROLE_CHANGE', 'PRODUCT_UPDATE', 'PRODUCT_PRICE_BULK_UPDATE', 'ORDER_STATUS_CHANGE', 'CATEGORY_UPDATE', 'OTHER');

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" SERIAL NOT NULL,
    "actorId" INTEGER NOT NULL,
    "actorRole" "Role" NOT NULL,
    "entityType" "AdminAuditEntityType" NOT NULL,
    "entityId" INTEGER,
    "action" "AdminAuditAction" NOT NULL,
    "meta" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_audit_log_actorId_createdAt_idx" ON "admin_audit_log"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_log_entityType_entityId_idx" ON "admin_audit_log"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
