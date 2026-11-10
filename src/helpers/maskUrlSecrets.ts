// query parameters that carry secrets: email and password tokens, oauth codes and states;
// a new secret query parameter has to be added here, or its value reaches the logs
const SECRET_QUERY_KEYS = new Set(['token', 'code', 'state']);

// paths that carry a secret in the path itself: the segment after the prefix is hidden. The link of
// the one-click unsubscribe of a newsletter mail holds the token of the subscription in its path
// (RFC 8058 puts the whole address into the List-Unsubscribe header); a new route with a secret in
// its path has to be added here, or the value reaches the logs
const SECRET_PATH_PREFIXES = [/^(\/+api\/+newsletters\/+unsubscribe\/+)[^/]+/i];

const HIDDEN = '[hidden]';

// the query parser decodes keys, so %74oken arrives as token and has to be hidden too
function decodeKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey.replaceAll('+', ' ')).toLowerCase();
  } catch {
    return rawKey.toLowerCase();
  }
}

// the router reads an encoded letter of the path as the letter (/%75nsubscribe), so the path is
// read decoded before it is compared with a prefix; a path that does not decode is compared as it is
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

// the path of a url for logs: the segment of a secret in the path is hidden, the rest stays as sent
function maskPath(path: string): string {
  const decoded = decodePath(path);

  for (const prefix of SECRET_PATH_PREFIXES) {
    const match = prefix.exec(decoded);
    if (match) return `${match[1]}${HIDDEN}${decoded.slice(match[0].length)}`;
  }

  return path;
}

// url for logs: path and query as sent, only the values of secret parameters and the secret
// segments of a path are hidden
export function maskUrlSecrets(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return maskPath(url);

  const path = maskPath(url.slice(0, queryStart));
  const query = url.slice(queryStart + 1);

  const parts = query.split('&').map((part) => {
    const eq = part.indexOf('=');
    if (eq === -1) return part;

    const rawKey = part.slice(0, eq);
    return SECRET_QUERY_KEYS.has(decodeKey(rawKey)) ? `${rawKey}=${HIDDEN}` : part;
  });

  return `${path}?${parts.join('&')}`;
}
