// split required vs optional keys
type RequiredKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];

type OptionalKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];

type RequiredPart<T> = {
  [K in RequiredKeys<T>]-?: Exclude<T[K], undefined>;
};

type OptionalPart<T> = {
  [K in OptionalKeys<T>]-?: T[K] | undefined;
};

// build output from required
export default function pickDefined<T extends object>(
  required: RequiredPart<T>,
  patch: OptionalPart<T>,
): T {
  // apply optional patch values
  const out: any = { ...required };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
