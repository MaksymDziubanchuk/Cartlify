// The name a trusted browser shows with in the list of an admin: the browser and the system, from
// the User-Agent of the request that trusted it ("Chrome, Windows"). The User-Agent itself is not
// kept: the name is all a person needs to tell their browsers apart.
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\b(OPR|Opera)\//, 'Opera'],
  [/\b(Firefox|FxiOS)\//, 'Firefox'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(Chrome|CriOS)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/\bWindows\b/, 'Windows'],
  [/\b(iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

const nameOf = (list: [RegExp, string][], userAgent: string): string | undefined =>
  list.find(([pattern]) => pattern.test(userAgent))?.[1];

export function deviceLabel(userAgent: string | undefined): string {
  const browser = userAgent ? nameOf(BROWSERS, userAgent) : undefined;
  const system = userAgent ? nameOf(SYSTEMS, userAgent) : undefined;

  if (browser && system) return `${browser}, ${system}`;
  return browser ?? system ?? 'Unknown browser';
}
