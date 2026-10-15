// query parameters that carry secrets: email and password tokens, oauth codes and states;
// a new secret query parameter has to be added here, or its value reaches the logs
const SECRET_QUERY_KEYS = new Set(['token', 'code', 'state']);

const HIDDEN = '[hidden]';

// the query parser decodes keys, so %74oken arrives as token and has to be hidden too
function decodeKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey.replaceAll('+', ' ')).toLowerCase();
  } catch {
    return rawKey.toLowerCase();
  }
}

// url for logs: path and query as sent, only the values of secret parameters are hidden
export function maskUrlSecrets(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;

  const path = url.slice(0, queryStart);
  const query = url.slice(queryStart + 1);

  const parts = query.split('&').map((part) => {
    const eq = part.indexOf('=');
    if (eq === -1) return part;

    const rawKey = part.slice(0, eq);
    return SECRET_QUERY_KEYS.has(decodeKey(rawKey)) ? `${rawKey}=${HIDDEN}` : part;
  });

  return `${path}?${parts.join('&')}`;
}
