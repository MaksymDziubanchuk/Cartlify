-- CreateTable
CREATE TABLE "variant_attribute_values" (
    "id" SERIAL NOT NULL,
    "variantId" INTEGER NOT NULL,
    "attributeId" INTEGER NOT NULL,
    "optionId" INTEGER,
    "textValue" TEXT,
    "numberValue" DECIMAL(18,3),
    "boolValue" BOOLEAN,

    CONSTRAINT "variant_attribute_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "variant_attribute_values_attributeId_optionId_idx" ON "variant_attribute_values"("attributeId", "optionId");

-- CreateIndex
CREATE INDEX "variant_attribute_values_optionId_idx" ON "variant_attribute_values"("optionId");

-- AddForeignKey
ALTER TABLE "variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "attributes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "attribute_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

