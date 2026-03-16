-- CreateIndex
CREATE INDEX "orders_userId_updatedAt_idx" ON "orders"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "orders_userId_confirmed_status_updatedAt_idx" ON "orders"("userId", "confirmed", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "orders_status_updatedAt_idx" ON "orders"("status", "updatedAt");
