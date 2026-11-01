import type { FormPart } from './multipart.js';

import { uniqueTag } from './factories.js';

// the manufacturer a new product names (the EU GPSR) as the text fields of a form: a party that is
// not in the directory yet, made in the EU, with a name of its own so that every product of a test
// adds a party and none meets the one another made. A value of the party can be changed by name
export function manufacturerFormFields(
  over: Partial<Record<'name' | 'address' | 'email' | 'country', string>> = {},
): FormPart[] {
  const tag = uniqueTag();
  const values = {
    name: `Lampwerk ${tag}`,
    address: 'Lichtstrasse 4, 10115 Berlin, Germany',
    email: 'safety@lampwerk.example.com',
    country: 'DE',
    ...over,
  };

  return Object.entries(values).map(([key, value]) => ({ name: `manufacturer.${key}`, value }));
}

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
