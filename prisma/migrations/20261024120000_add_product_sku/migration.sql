-- the article number of a product; its form and its uniqueness in the catalog are in db/06
ALTER TABLE "products" ADD COLUMN     "sku" VARCHAR(64);
