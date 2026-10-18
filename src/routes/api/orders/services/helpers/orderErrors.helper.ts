import { getPgMessage } from '@db/client.js';

// the order items trigger refuses a change of an order that is no longer an open cart:
// ORDER_NOT_EDITABLE when rls hides the order (it is foreign or already confirmed),
// ORDER_ALREADY_CONFIRMED when the order is visible but confirmed
export function isOrderNotEditable(err: unknown): boolean {
  const message = getPgMessage(err) ?? '';

  return message.includes('ORDER_NOT_EDITABLE') || message.includes('ORDER_ALREADY_CONFIRMED');
}
