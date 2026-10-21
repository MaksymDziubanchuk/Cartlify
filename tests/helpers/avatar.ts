// the letter and the color an avatar of initials draws (src/utils/avatar.util.ts): Cloudinary
// draws them at the url, so the url tells what the picture shows. null for any other url
export function drawnAvatar(url: string): { letter: string; color: string } | null {
  const match =
    /\/e_colorize:100,co_rgb:([0-9A-F]{6})\/l_text:Roboto_\d+_bold:([^,/]+),co_white\//.exec(url);

  return match ? { color: match[1]!, letter: decodeURIComponent(match[2]!) } : null;
}

// the one letter and color of all four sizes; a size that draws another one fails the check
export function drawnAvatarOf(avatarUrls: Record<string, string>) {
  const drawn = Object.values(avatarUrls).map(drawnAvatar);
  const first = drawn[0] ?? null;
  const same = drawn.every((one) => one?.letter === first?.letter && one?.color === first?.color);

  return same ? first : { sizes: drawn };
}
