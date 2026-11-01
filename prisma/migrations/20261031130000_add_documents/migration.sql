-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('instruction', 'certificate', 'declaration', 'other');

-- AlterEnum
ALTER TYPE "AdminAuditEntityType" ADD VALUE 'document';

-- CreateTable
CREATE TABLE "documents" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "url" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_documents" (
    "productId" INTEGER NOT NULL,
    "documentId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "product_documents_pkey" PRIMARY KEY ("productId","documentId")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_publicId_key" ON "documents"("publicId");

-- CreateIndex
CREATE INDEX "documents_kind_idx" ON "documents"("kind");

-- CreateIndex
CREATE INDEX "product_documents_documentId_idx" ON "product_documents"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "product_documents_productId_position_key" ON "product_documents"("productId", "position");

-- AddForeignKey
ALTER TABLE "product_documents" ADD CONSTRAINT "product_documents_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_documents" ADD CONSTRAINT "product_documents_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
