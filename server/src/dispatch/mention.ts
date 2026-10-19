/**
 * `@reviewx` mention handling for comment bodies.
 *
 * A mention counts only as a standalone token (`@reviewx`, `@reviewx,`, `@reviewx:`),
 * so `@reviewx-bot` or `email@reviewx.dev` never trigger a run. Matching is
 * case-insensitive because GitHub logins are.
 */
export function mentionPattern(appSlug: string): RegExp {
  const slug = appSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@/-])@${slug}(?![\\w-])`, "i");
}

export function hasMention(body: string | null | undefined, appSlug: string): boolean {
  if (!body) return false;
  return mentionPattern(appSlug).test(body);
}

/**
 * The user's request with every `@reviewx` token removed and whitespace
 * collapsed. Empty when the comment was a bare mention.
 */
export function stripMention(body: string, appSlug: string): string {
  const slug = appSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body
    .replace(new RegExp(`(^|[^\\w@/-])@${slug}(?![\\w-])[,:]?`, "gi"), "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
