-- the lowest price of the 30 days before a sale; its rule is in db/06
ALTER TABLE "products" ADD COLUMN     "salePriorPrice" DECIMAL(10,2);
