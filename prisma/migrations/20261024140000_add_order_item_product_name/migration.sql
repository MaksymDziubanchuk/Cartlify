-- the name of the product an item holds, kept by the confirm (db/05)
ALTER TABLE "order_items" ADD COLUMN     "productName" TEXT;
