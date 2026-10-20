/**
 * true when a GitHub login belongs to the ReviewX app.
 */
export function isReviewx(actor: string | null | undefined): boolean {
  actor = actor?.toLowerCase().replace("[bot]", "");
  return !!actor && actor === "reviewx-bot";
}
