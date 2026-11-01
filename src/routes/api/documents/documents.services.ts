import { createDocument } from './services/createDocument.service.js';
import { deleteDocument } from './services/deleteDocument.service.js';
import { getDocument } from './services/getDocument.service.js';
import { listDocuments } from './services/listDocuments.service.js';
import { updateDocument } from './services/updateDocument.service.js';

export const documentsServices = {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
};
