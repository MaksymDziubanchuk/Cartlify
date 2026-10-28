import {
  AUDIT_EVENTS,
  CONSENT_EVENTS,
  LOGIN_EVENTS,
  PRICE_LOG_EVENTS,
} from '@config/journalEvents.js';

import type { GetAdminLogEventsResponseDto } from 'types/dto/admin.dto.js';

// the events every journal writes (GET /api/admin/log-events): what the checkboxes of a page of a
// journal list. The line of a time before the events has legacy.unknown in each
export function getLogEvents(): GetAdminLogEventsResponseDto {
  return {
    auditLog: [...AUDIT_EVENTS],
    priceLog: [...PRICE_LOG_EVENTS],
    loginLog: [...LOGIN_EVENTS],
    consentLog: [...CONSENT_EVENTS],
  };
}
