-- The second step of the login of an ADMIN or ROOT (user_two_factor): the encrypted secret of the
-- authenticator app, the last time step a code was taken for, the recovery codes (the ones not used
-- yet and the used ones), the browsers an admin trusts and the pause after wrong codes.

-- CreateTable
CREATE TABLE "user_two_factor" (
    "userId" INTEGER NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedStep" INTEGER NOT NULL DEFAULT 0,
    "recoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "usedRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trustedDevices" JSONB NOT NULL DEFAULT '[]',
    "failedCodes" INTEGER NOT NULL DEFAULT 0,
    "pausedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_two_factor_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "user_two_factor" ADD CONSTRAINT "user_two_factor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

