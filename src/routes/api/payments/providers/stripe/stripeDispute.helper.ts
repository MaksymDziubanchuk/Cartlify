import stripe from '@config/stripe.js';
import { InternalError, ServiceUnavailableError } from '@utils/errors.js';

import {
  amountOfCents,
  isStripeResourceMissing,
  isStripeUnavailable,
} from './stripeCheckout.helper.js';

import type Stripe from 'stripe';
import type {
  DisputeEvidence,
  DisputeEvidenceAnswer,
  DisputeStatus,
  PaymentDispute,
} from '../types.js';

// the states of a dispute the database keeps (payment_disputes.status); a state stripe adds later
// is not one of them
const DISPUTE_STATUSES: readonly DisputeStatus[] = [
  'warning_needs_response',
  'warning_under_review',
  'warning_closed',
  'needs_response',
  'under_review',
  'won',
  'lost',
  'prevented',
];

// the fields of the draft of the evidence, in the words of stripe; only text, never a file
const EVIDENCE_FIELDS = {
  productDescription: 'product_description',
  customerName: 'customer_name',
  customerEmailAddress: 'customer_email_address',
  shippingAddress: 'shipping_address',
  shippingCarrier: 'shipping_carrier',
  shippingTrackingNumber: 'shipping_tracking_number',
  shippingDate: 'shipping_date',
  refundPolicyDisclosure: 'refund_policy_disclosure',
  refundRefusalExplanation: 'refund_refusal_explanation',
  uncategorizedText: 'uncategorized_text',
} as const satisfies Record<keyof DisputeEvidence, keyof Stripe.DisputeUpdateParams.Evidence>;

// the longest text of a refusal the app keeps
const REFUSAL_TEXT_MAX = 500;

const dateOf = (seconds: number) => new Date(seconds * 1000);

// a dispute as stripe has it now, in the answer of the app: its state, its dates and the money it
// moved on the balance of the shop (stripe always sends the balance transactions with it)
function disputeOf(dispute: Stripe.Dispute): PaymentDispute {
  const status = DISPUTE_STATUSES.find((known) => known === dispute.status);

  if (!status) {
    throw new InternalError({
      reason: 'STRIPE_DISPUTE_STATUS_UNKNOWN',
      disputeId: dispute.id,
      status: dispute.status,
    });
  }

  const payment = dispute.payment_intent;
  const dueBy = dispute.evidence_details.due_by;

  return {
    id: dispute.id,
    paymentId: typeof payment === 'string' ? payment : (payment?.id ?? null),
    status,
    reason: dispute.reason,
    amount: amountOfCents(dispute.amount),
    currency: dispute.currency,
    evidenceDueBy: dueBy === null ? null : dateOf(dueBy),
    hasEvidence: dispute.evidence_details.has_evidence,
    submissionCount: dispute.evidence_details.submission_count,
    isChargeRefundable: dispute.is_charge_refundable,
    openedAt: dateOf(dispute.created),
    transactions: dispute.balance_transactions.map((transaction) => ({
      id: transaction.id,
      amount: amountOfCents(transaction.amount),
      fee: amountOfCents(transaction.fee),
      currency: transaction.currency,
      createdAt: dateOf(transaction.created),
    })),
  };
}

// stripe out of reach is PAYMENT_PROVIDER_UNAVAILABLE (ask again later), a dispute it has no
// record of a server error; anything else goes on as it is
function disputeFailure(err: unknown, disputeId: string): unknown {
  if (isStripeUnavailable(err)) {
    return new ServiceUnavailableError('PAYMENT_PROVIDER_UNAVAILABLE', undefined, err);
  }

  if (isStripeResourceMissing(err)) {
    return new InternalError({ reason: 'STRIPE_DISPUTE_NOT_FOUND', disputeId }, err);
  }

  return err;
}

// a dispute as it stands at stripe now, whatever event told of it: the events of a dispute may
// come in any order, its state is read from stripe each time
export async function getStripeDispute(disputeId: string): Promise<PaymentDispute> {
  let dispute: Stripe.Dispute;

  try {
    dispute = await stripe.disputes.retrieve(disputeId);
  } catch (err) {
    throw disputeFailure(err, disputeId);
  }

  return disputeOf(dispute);
}

// puts a draft of the evidence on a dispute (submit: false) and never submits it: a person reads it
// in the dashboard of stripe, adds to it and submits it there. A refusal of stripe (the dispute is
// closed, the evidence was submitted already) is the answer, with its words
export async function putStripeDisputeEvidence(
  disputeId: string,
  evidence: DisputeEvidence,
): Promise<DisputeEvidenceAnswer> {
  const fields: Stripe.DisputeUpdateParams.Evidence = {};

  for (const [ours, theirs] of Object.entries(EVIDENCE_FIELDS) as [
    keyof DisputeEvidence,
    (typeof EVIDENCE_FIELDS)[keyof DisputeEvidence],
  ][]) {
    const value = evidence[ours];
    if (value !== undefined) fields[theirs] = value;
  }

  try {
    await stripe.disputes.update(disputeId, { evidence: fields, submit: false });
    return { status: 'put' };
  } catch (err) {
    const failure = disputeFailure(err, disputeId);
    if (failure !== err) throw failure;

    const e = err as { type?: unknown; message?: unknown } | null;
    if (e?.type === 'StripeInvalidRequestError') {
      return {
        status: 'refused',
        refusalText: String(e.message ?? '').slice(0, REFUSAL_TEXT_MAX),
      };
    }

    throw err;
  }
}
