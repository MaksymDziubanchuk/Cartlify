// what the buyer paid the carrier for the parcel the goods go back to the shop in, and how an admin
// confirms that parcel (db/05, confirm_return_parcel): the routes of the buyer, of the public form
// and of the admins share them

export const buyerPaidField = {
  type: 'number',
  minimum: 0,
  maximum: 99_999_999.99,
  multipleOf: 0.01,
  description:
    'What the buyer paid the carrier for the parcel, to the cent: a hint for the shop, which sets ' +
    'the sum from the receipt when it confirms the parcel. When the shop pays the way back it gives ' +
    'that sum back, never more.',
} as const;

const costField = {
  type: 'number',
  minimum: 0,
  maximum: 99_999_999.99,
  multipleOf: 0.01,
  description:
    'What the shop paid the carrier for the parcel, to the cent (a label of the shop, a parcel paid on receipt, a courier of the shop).',
} as const;

// who paid the carrier, said when an admin confirms the parcel: the shop (cost) or the buyer
// (buyerPaid, from the receipt; 0 when the buyer gave none), not both
export const parcelSumsProperties = {
  buyerPaid: {
    ...buyerPaidField,
    description:
      'What the buyer paid the carrier, from the receipt (0 when the buyer gave none); replaces what ' +
      'the buyer told. Required when the shop pays the way back and did not pay the carrier ' +
      '(RETURN_PARCEL_SUM_REQUIRED).',
  },
  cost: costField,
} as const;

// the parcel to the shop an admin confirms with the goods in hand, when it is not confirmed yet: who
// paid the carrier, and for a parcel nobody told of yet its carrier, number and link
export const receiveParcelField = {
  type: 'object',
  additionalProperties: false,
  description:
    'The parcel the goods came in, confirmed in the same step when it is not confirmed yet: required ' +
    'then for goods that came or were lost on the way (RETURN_PARCEL_REQUIRED). The carrier, the number ' +
    'and the link are taken for a parcel nobody told of yet (the buyer brought the goods, or wrote to the ' +
    'shop).',
  properties: {
    ...parcelSumsProperties,
    carrier: { type: 'string', minLength: 1, maxLength: 100 },
    trackingNumber: { type: 'string', minLength: 1, maxLength: 100 },
    trackingUrl: { type: 'string', maxLength: 500, pattern: '^https://[^\\s]+$' },
  },
} as const;
