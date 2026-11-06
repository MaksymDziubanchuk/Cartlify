-- The data of the shop is kept by key: a row is one setting and the value it took, not a full
-- version of every setting (docs/shop-settings.md). The rows of the versions are not carried
-- over; the server fills in its defaults at its next start, root sets the rest again.

-- DropTable
DROP TABLE "shop_settings";

-- CreateTable
CREATE TABLE "shop_settings" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "setById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_settings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "shop_settings" ADD CONSTRAINT "shop_settings_setById_fkey" FOREIGN KEY ("setById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
