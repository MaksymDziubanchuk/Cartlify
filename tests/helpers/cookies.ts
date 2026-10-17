export type SetCookie = {
  value: string;
  // an empty value or an expiry in the past: the browser drops the cookie
  cleared: boolean;
  // the attributes as sent, for example HttpOnly, SameSite=Lax, Max-Age=1200
  attributes: string[];
  maxAge: number | undefined;
};

type WithHeaders = { headers: Record<string, unknown> };

// the cookies a response sets, by name
export function setCookies(res: WithHeaders): Record<string, SetCookie> {
  const lines = [res.headers['set-cookie']].flat().filter(Boolean).map(String);

  return Object.fromEntries(
    lines.map((line) => {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim());
      const name = pair!.slice(0, pair!.indexOf('='));
      const value = pair!.slice(pair!.indexOf('=') + 1);
      const maxAgeAttr = attributes.find((a) => /^max-age=/i.test(a));
      const maxAge = maxAgeAttr ? Number(maxAgeAttr.split('=')[1]) : undefined;
      const cleared =
        value === '' || maxAge === 0 || attributes.some((a) => /^expires=.*1970/i.test(a));

      return [name, { value, cleared, attributes, maxAge }];
    }),
  );
}

// a cookie header the way a browser sends it; empty values are left out
export const cookieHeader = (cookies: Record<string, string | undefined>) =>
  Object.entries(cookies)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

// the values of the cookies a response sets, ready to send back
export const cookieJar = (res: WithHeaders): Record<string, string> =>
  Object.fromEntries(
    Object.entries(setCookies(res))
      .filter(([, cookie]) => !cookie.cleared)
      .map(([name, cookie]) => [name, cookie.value]),
  );
