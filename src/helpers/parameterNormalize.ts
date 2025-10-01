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

export default function pickDefined<T extends object>(
  required: RequiredPart<T>,
  patch: OptionalPart<T>,
): T {
  const out: any = { ...required };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
