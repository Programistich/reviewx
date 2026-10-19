/**
 * true when a GitHub login belongs to the ReviewX production or development app.
 */
export function isReviewx(actor: string | null | undefined): boolean {
  actor = actor?.toLowerCase().replace("[bot]", "");
  return !!actor && (actor === "reviewx-bot" || actor === "reviewxdev");
}
