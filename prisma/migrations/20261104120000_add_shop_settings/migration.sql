-- CreateTable
CREATE TABLE "shop_settings" (
    "id" SERIAL NOT NULL,
    "version" INTEGER NOT NULL,
    "setById" INTEGER,
    "basedOnVersion" INTEGER,
    "deliveryMethods" TEXT[],
    "deliveryFlatPrice" DECIMAL(10,2),
    "deliveryFreeFrom" DECIMAL(10,2),
    "deliveryCountries" TEXT[],
    "pickupAddress" VARCHAR(300),
    "pickupHours" VARCHAR(300),
    "shopName" VARCHAR(100),
    "emailFromName" VARCHAR(100),
    "emailReplyTo" VARCHAR(254),
    "logoUrl" TEXT,
    "logoPublicId" TEXT,
    "reservationMinutes" INTEGER,
    "stripePageMinutes" INTEGER,
    "reviewCheckEnabled" BOOLEAN,
    "avatarRemovalsLimit" INTEGER,
    "reviewRemovalsLimit" INTEGER,
    "withdrawalGraceDays" INTEGER,
    "shopLocale" VARCHAR(2),
    "enabledLocales" TEXT[],
    "sellerLegalName" VARCHAR(200),
    "sellerAddress" VARCHAR(500),
    "sellerTaxId" VARCHAR(50),
    "sellerEmail" VARCHAR(254),
    "sellerPhone" VARCHAR(30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shop_settings_version_key" ON "shop_settings"("version");

-- AddForeignKey
ALTER TABLE "shop_settings" ADD CONSTRAINT "shop_settings_setById_fkey" FOREIGN KEY ("setById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

