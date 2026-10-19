/**
 * Internal entrypoint for the ReviewX server.
 * Re-exports the types and helpers the dispatcher shares with the action.
 */

export type {
  AuthorPermission,
  Payload,
  PayloadEvent,
  PushPermission,
  ShellPermission,
  WriteablePayload,
} from "../external.ts";
export { pullfrogMcpName } from "../external.ts";
export type { BuildFooterParams, WorkflowRunFooterInfo } from "../utils/footer.ts";
export {
  buildFooter,
  REVIEWX_DIVIDER,
  REVIEWX_REPO_URL,
  stripExistingFooter,
} from "../utils/footer.ts";
export { isPullfrog } from "../utils/isPullfrog.ts";
export {
  isLeapingIntoActionCommentBody,
  LEAPING_INTO_ACTION_PREFIX,
} from "../utils/leapingComment.ts";
export type {
  CreateProgressCommentTarget,
  CreatedProgressComment,
  ProgressComment,
  ProgressCommentOctokit,
  ProgressCommentType,
} from "../utils/progressComment.ts";
export {
  createLeapingProgressComment,
  deleteProgressCommentApi,
  getProgressComment,
  updateProgressComment,
} from "../utils/progressComment.ts";
export type {
  RunStatusCheckConclusion,
  RunStatusCheckOctokit,
} from "../utils/runStatusCheck.ts";
export {
  APPROVAL_CHECK_NAME,
  createRunStatusCheck,
  createTerminalRunStatusCheck,
  finalizeRunStatusCheck,
  RUN_STATUS_CHECK_NAME,
  runStatusCheckNeedsFinalizing,
} from "../utils/runStatusCheck.ts";
