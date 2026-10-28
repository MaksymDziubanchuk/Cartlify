import type { FormPart } from './multipart.js';

// the safety and origin data an offer of a product shows (the EU GPSR): the manufacturer, a person
// responsible in the EU when the manufacturer is outside it, and the warnings. A new product needs
// them; this one is made in the EU
export type ProductSafetyInput = {
  manufacturer: { name: string; address: string; email: string; country: string };
  responsiblePerson?: { name: string; address: string; email: string } | null;
  warnings?: string | null;
};

export const productSafety: ProductSafetyInput = {
  manufacturer: {
    name: 'Lampwerk GmbH',
    address: 'Lichtstrasse 4, 10115 Berlin, Germany',
    email: 'safety@lampwerk.example.com',
    country: 'DE',
  },
};

// what a new product weighs and measures packed: the weight in grams and the three sizes in
// millimetres, as the text fields of a form. A new product needs them
export function shippingFormFields(): FormPart[] {
  return [
    { name: 'weightGrams', value: '350' },
    { name: 'lengthMm', value: '200' },
    { name: 'widthMm', value: '100' },
    { name: 'heightMm', value: '50' },
  ];
}

// the same data as the text fields of a form: safety.manufacturer.name and so on
export function safetyFormFields(safety: ProductSafetyInput = productSafety): FormPart[] {
  const parts: FormPart[] = Object.entries(safety.manufacturer).map(([key, value]) => ({
    name: `safety.manufacturer.${key}`,
    value,
  }));
  for (const [key, value] of Object.entries(safety.responsiblePerson ?? {})) {
    parts.push({ name: `safety.responsiblePerson.${key}`, value });
  }
  if (safety.warnings) parts.push({ name: 'safety.warnings', value: safety.warnings });
  return parts;
}
