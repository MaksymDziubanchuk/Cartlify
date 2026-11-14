// the address of a picture of a provider of accounts as the server takes it: https, no user, no
// password and no port, on a host the provider keeps its pictures on; null for any other address,
// which the server never opens (the address comes from the provider, the server follows it nowhere)
export function pictureAddressOf(
  raw: string,
  isHostOfProvider: (host: string) => boolean,
): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (!isHostOfProvider(url.hostname.toLowerCase())) return null;

  return url;
}
