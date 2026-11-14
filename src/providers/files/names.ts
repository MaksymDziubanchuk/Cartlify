// the file storages this server can keep the files of the shop in (the pictures, the pdf files of the
// documents); FILE_STORAGE_PROVIDER names the one it works with. No client here, the tests read it
export const FILE_STORAGE_PROVIDER_NAMES = ['cloudinary'] as const;

export type FileStorageProviderName = (typeof FILE_STORAGE_PROVIDER_NAMES)[number];
