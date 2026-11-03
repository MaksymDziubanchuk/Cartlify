-- AlterEnum
ALTER TYPE "ReturnCloseCode" ADD VALUE 'stated_again';

-- AlterEnum
ALTER TYPE "ReturnOutsideMethod" ADD VALUE 'chargeback';

-- AlterTable: the statements there are get their numbers in their order by the time they were made
ALTER TABLE "returns" ADD COLUMN     "number" INTEGER;

UPDATE "returns" AS r
SET "number" = n.rn
FROM (SELECT id, row_number() OVER (PARTITION BY "orderId" ORDER BY id) AS rn FROM "returns") AS n
WHERE n.id = r.id;

ALTER TABLE "returns" ALTER COLUMN "number" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "returns_orderId_number_key" ON "returns"("orderId", "number");
