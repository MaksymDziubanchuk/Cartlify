-- CreateTable
CREATE TABLE "return_shipments" (
    "id" SERIAL NOT NULL,
    "returnId" INTEGER NOT NULL,
    "carrier" VARCHAR(100),
    "trackingNumber" VARCHAR(100),
    "trackingUrl" VARCHAR(500),
    "cost" DECIMAL(10,2),
    "shippedAt" TIMESTAMP(3) NOT NULL,
    "recordedById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "return_shipments_returnId_idx" ON "return_shipments"("returnId");

-- CreateIndex
CREATE INDEX "return_shipments_shippedAt_idx" ON "return_shipments"("shippedAt");

-- AddForeignKey
ALTER TABLE "return_shipments" ADD CONSTRAINT "return_shipments_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_shipments" ADD CONSTRAINT "return_shipments_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

