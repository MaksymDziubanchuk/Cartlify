// LEGAL: the versions of the terms, of the contract and of the privacy policy of the shop, and the
// consents to the terms and to the contract

export type LegalDocumentKind = 'terms' | 'contract' | 'privacy';

// the kinds a customer accepts; the privacy policy only informs, nobody accepts it
export type ConsentKind = Exclude<LegalDocumentKind, 'privacy'>;

// who pays the carrier for the parcel a buyer sends back when they withdraw
export type ReturnShippingPayer = 'buyer' | 'shop';

// what only a contract says: the days a buyer has to withdraw after the delivery (14 at least),
// where they send the goods back, who pays the carrier for it
export interface ContractTermsDto {
  withdrawalDays: number;
  returnAddress: string;
  returnShippingPaidBy: ReturnShippingPayer;
}

// what only a privacy policy says: how long each kind of personal data is kept, in days
export interface PrivacyRetentionDto {
  // the address and the browser of the logins
  loginAddressesDays: number;
  // the favorites and the chats of a guest, counted from their last activity
  guestDataDays: number;
  // the chats of a deleted account, counted from its deletion
  deletedChatsDays: number;
  // the address and the browser of a statement of withdrawal, counted from its closing
  returnAddressesDays: number;
  // the name, the email, the phone and the text of a statement, counted from its closing
  returnPersonalDays: number;
  // the recipient and the address of an order, counted from the deletion of the account of its buyer
  recipientDays: number;
  // an ended newsletter subscription with its journal (the proof of the consent), counted from its end
  newsletterConsentDays: number;
  // the rows of the recipients of a newsletter campaign, counted from the end of the campaign
  newsletterRecipientsDays: number;
}

// a version with its text; contract is the terms of a contract and retention the terms of a privacy
// policy, null for the other kinds
export interface LegalDocumentDto {
  id: number;
  kind: LegalDocumentKind;
  version: number;
  title: string;
  content: string;
  sha256: string;
  publishedAt: string;
  contract: ContractTermsDto | null;
  retention: PrivacyRetentionDto | null;
}

// a version of a kind a customer accepts, without its text
export interface LegalDocumentSummaryDto {
  id: number;
  kind: ConsentKind;
  version: number;
  title: string;
}

// a version in the history root reads, with who published it
export interface LegalDocumentHistoryItemDto {
  id: number;
  kind: LegalDocumentKind;
  version: number;
  title: string;
  sha256: string;
  publishedAt: string;
  publishedBy: { id: number; name: string | null; email: string | null };
}

export interface PublishLegalDocumentBodyDto {
  kind: LegalDocumentKind;
  title: string;
  content: string;
  // a contract has contract, a privacy policy has retention, the terms have neither
  contract?: ContractTermsDto;
  retention?: PrivacyRetentionDto;
}

export interface LegalDocumentsHistoryQueryDto {
  kind?: LegalDocumentKind;
  limit?: number;
  cursor?: string;
}

export interface LegalDocumentsHistoryResponseDto {
  items: LegalDocumentHistoryItemDto[];
  nextCursor: string | null;
}

export interface LegalDocumentParamsDto {
  documentId: number | string;
}

// what the customer accepted of each kind, the version in force or an older one
export interface LegalAcceptedDto {
  documentId: number;
  kind: ConsentKind;
  version: number;
  acceptedAt: string;
}

// the versions in force, what the customer accepted, and the kinds still to accept
export interface LegalAcceptanceStatusDto {
  current: LegalDocumentSummaryDto[];
  accepted: LegalAcceptedDto[];
  required: ConsentKind[];
}

export interface AcceptLegalDocumentsBodyDto {
  documentIds: number[];
}
