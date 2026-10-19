/**
 * `@reviewx` mention handling for comment bodies.
 *
 * Both the App's real slug (`@reviewx-bot`, what GitHub autocompletes) and the
 * short alias `@reviewx` count, as standalone tokens only (`@reviewx`,
 * `@reviewx,`, `@reviewx:`), so `email@reviewx.dev` never triggers a run.
 * Matching is case-insensitive because GitHub logins are.
 */
export const MENTION_ALIAS = "reviewx";

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function names(appSlug: string): string {
  const unique = [...new Set([appSlug, MENTION_ALIAS].map((n) => n.toLowerCase()))];
  // longest first so `@reviewx-bot` is consumed whole before `@reviewx` gets a chance.
  unique.sort((a, b) => b.length - a.length);
  return unique.map(escape).join("|");
}

export function mentionPattern(appSlug: string): RegExp {
  return new RegExp(`(^|[^\\w@/-])@(?:${names(appSlug)})(?![\\w-])`, "i");
}

export function hasMention(body: string | null | undefined, appSlug: string): boolean {
  if (!body) return false;
  return mentionPattern(appSlug).test(body);
}

/**
 * The user's request with every mention token removed and whitespace
 * collapsed. Empty when the comment was a bare mention.
 */
export function stripMention(body: string, appSlug: string): string {
  return body
    .replace(new RegExp(`(^|[^\\w@/-])@(?:${names(appSlug)})(?![\\w-])[,:]?`, "gi"), "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
