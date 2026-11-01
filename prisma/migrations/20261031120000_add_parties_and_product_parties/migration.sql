-- AlterEnum
ALTER TYPE "AdminAuditEntityType" ADD VALUE 'party';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "euResponsibleId" INTEGER,
ADD COLUMN     "manufacturerId" INTEGER NOT NULL,
ADD COLUMN     "warnings" TEXT;

-- CreateTable
CREATE TABLE "parties" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parties_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "products_manufacturerId_idx" ON "products"("manufacturerId");

-- CreateIndex
CREATE INDEX "products_euResponsibleId_idx" ON "products"("euResponsibleId");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_euResponsibleId_fkey" FOREIGN KEY ("euResponsibleId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
