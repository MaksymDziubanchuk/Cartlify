import { acceptLegalDocuments, getAcceptanceStatus } from './services/legalAcceptances.service.js';
import {
  getCurrentLegalDocuments,
  getLegalDocument,
  listLegalDocuments,
  publishLegalDocument,
} from './services/legalDocuments.service.js';

export const legalServices = {
  getCurrentLegalDocuments,
  getLegalDocument,
  publishLegalDocument,
  listLegalDocuments,
  getAcceptanceStatus,
  acceptLegalDocuments,
};
