/**
 * `@<app-slug>` mention handling for comment bodies.
 *
 * Only the App's own slug counts (`@reviewx-bot`), as a standalone token
 * (`@reviewx-bot`, `@reviewx-bot,`, `@reviewx-bot:`), so `email@reviewx-bot.dev`
 * never triggers a run. Matching is case-insensitive because GitHub logins are.
 */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionPattern(appSlug: string): RegExp {
  return new RegExp(`(^|[^\\w@/-])@${escape(appSlug)}(?![\\w-])`, "i");
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
    .replace(new RegExp(`(^|[^\\w@/-])@${escape(appSlug)}(?![\\w-])[,:]?`, "gi"), "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
