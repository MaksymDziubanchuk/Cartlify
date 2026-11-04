-- AlterTable
ALTER TABLE "returns" ADD COLUMN     "shippingReimbursed" DECIMAL(10,2),
ADD COLUMN     "shippingReimbursedAt" TIMESTAMP(3),
ADD COLUMN     "shippingReimbursedById" INTEGER,
ADD COLUMN     "shippingReimbursedMethod" "ReturnOutsideMethod",
ADD COLUMN     "shippingReimbursedNote" VARCHAR(500);

-- AlterTable
ALTER TABLE "return_items" ADD COLUMN     "shippingDeduction" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_shippingReimbursedById_fkey" FOREIGN KEY ("shippingReimbursedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

