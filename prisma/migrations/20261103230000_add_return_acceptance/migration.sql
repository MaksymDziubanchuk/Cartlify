-- AlterTable
ALTER TABLE "returns" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "acceptedById" INTEGER;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

