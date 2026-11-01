-- CreateEnum
CREATE TYPE "AttributeType" AS ENUM ('text', 'number', 'boolean', 'option', 'options');

-- AlterEnum
ALTER TYPE "AdminAuditEntityType" ADD VALUE 'attribute';

-- CreateTable
CREATE TABLE "attribute_groups" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attribute_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attributes" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AttributeType" NOT NULL,
    "unit" TEXT,
    "groupId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "isMain" BOOLEAN NOT NULL DEFAULT false,
    "inFilters" BOOLEAN NOT NULL DEFAULT true,
    "decimals" INTEGER,
    "minValue" DECIMAL(18,3),
    "maxValue" DECIMAL(18,3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_options" (
    "id" SERIAL NOT NULL,
    "attributeId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "colorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attribute_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_attributes" (
    "categoryId" INTEGER NOT NULL,
    "attributeId" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "category_attributes_pkey" PRIMARY KEY ("categoryId","attributeId")
);

-- CreateIndex
CREATE INDEX "attributes_groupId_idx" ON "attributes"("groupId");

-- CreateIndex
CREATE INDEX "attribute_options_attributeId_idx" ON "attribute_options"("attributeId");

-- CreateIndex
CREATE INDEX "category_attributes_attributeId_idx" ON "category_attributes"("attributeId");

-- AddForeignKey
ALTER TABLE "attributes" ADD CONSTRAINT "attributes_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "attribute_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_options" ADD CONSTRAINT "attribute_options_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_attributes" ADD CONSTRAINT "category_attributes_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_attributes" ADD CONSTRAINT "category_attributes_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "attributes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
