# ReviewX

AI code review for pull requests that runs in **your** GitHub Actions with **your** model keys.

ReviewX is a self-hosted fork of [Pullfrog](https://github.com/pullfrog/pullfrog) (MIT). It wraps the vendor's real coding agent — [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex) or [OpenCode](https://github.com/anomalyco/opencode), picked by the key you provide — and gives it a purpose-built MCP server for GitHub: reading the diff, leaving a review with inline comments, replying in threads, pushing fixes. There is no billing, no console and no stored secrets: the server only turns webhooks into workflow runs and issues short-lived GitHub tokens.

What it does on a PR:

- **Opened / ready for review** → a full review: a severity callout, a summary of the changes, inline comments anchored to lines.
- **New commits pushed** → an incremental re-review of just the delta, noting which earlier threads are still open.
- **`@reviewx-bot <anything>`** in a PR comment or review thread → the agent answers, explains, or makes the change and pushes it.

## Setup

Three steps, about two minutes.

### 1. Install the GitHub App

[**Install reviewx-bot →**](https://github.com/apps/reviewx-bot/installations/new) on the repositories you want reviewed. The App only ever acts on repositories it is installed on.

### 2. Add the workflow

Copy [`templates/reviewx.yml`](templates/reviewx.yml) to `.github/workflows/reviewx.yml` on your default branch. The App dispatches this workflow with a JSON prompt; it never triggers on PR events itself, so it always runs the trusted copy from your default branch and works for PRs from forks.

```yaml
name: ReviewX
run-name: ${{ inputs.name || github.workflow }}
on:
  workflow_dispatch:
    inputs:
      prompt: { type: string, description: Agent prompt }
      name: { type: string, description: Run name }

jobs:
  reviewx:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 1 }
      - uses: programistich/reviewx@v1
        with:
          prompt: ${{ inputs.prompt }}
          model: ${{ vars.REVIEWX_MODEL }}
          base_instructions: ${{ vars.REVIEWX_BASE_INSTRUCTIONS }}
          review_instructions: ${{ vars.REVIEWX_REVIEW_INSTRUCTIONS }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

`id-token: write` is what lets the action exchange its GitHub OIDC token for a scoped installation token at `reviewx.programistich.com`; `contents: read` is all the job token needs. Everything the agent does on GitHub goes through the installation token, which is revoked when the run ends.

### 3. Add a model key

Add one of these as a GitHub Actions secret and reference it from the workflow's `env:` block (the template lists the common ones):

| Provider | Secret | Notes |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | runs through Claude Code |
| Claude Pro / Max subscription | `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` prints it; see [Claude subscription](#claude-subscription) |
| OpenAI | `OPENAI_API_KEY` | runs through Codex |
| ChatGPT subscription | `CODEX_AUTH_JSON` | contents of `~/.codex/auth.json` after `codex login`; see [ChatGPT subscription](#chatgpt-subscription) |
| Google | `GEMINI_API_KEY` | |
| OpenRouter | `OPENROUTER_API_KEY` | any model OpenRouter serves |
| xAI, Mistral, DeepSeek, Groq, … | `XAI_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY` | via OpenCode |

Then open a pull request. Within a few seconds `reviewx-bot` posts "ReviewX is working…", a `reviewx` check-run appears on the PR head, and the review lands when the run finishes.

## Settings

All settings are action inputs. The recommended pattern is to forward [GitHub Variables](https://docs.github.com/en/actions/learn-github-actions/variables) (`${{ vars.REVIEWX_* }}`) so you can change them per repository or organization without editing the workflow; an empty variable means "default".

| Input | Variable (suggested) | Default | What it does |
| --- | --- | --- | --- |
| `model` | `REVIEWX_MODEL` | picked from the keys present | `anthropic/claude-sonnet`, `openai/gpt-5`, `google/gemini-pro`, an OpenRouter slug, or a raw models.dev id |
| `effort` | `REVIEWX_EFFORT` | model default | `low`, `medium`, `high`, `xhigh`, `max`, or a position on `[0,1]` |
| `base_instructions` | `REVIEWX_BASE_INSTRUCTIONS` | — | standing instructions for every run |
| `review_instructions` | `REVIEWX_REVIEW_INSTRUCTIONS` | — | instructions for reviews: language, focus areas, severity policy |
| `fix_instructions` | `REVIEWX_FIX_INSTRUCTIONS` | — | instructions for `@reviewx-bot fix` runs |
| `task_instructions` | `REVIEWX_TASK_INSTRUCTIONS` | — | instructions for free-form `@reviewx-bot` requests |
| `push` | | `restricted` | `disabled` (read-only), `restricted` (feature branches only), `enabled` |
| `shell` | | `restricted` | `disabled`, `restricted` (secrets filtered), `enabled`; non-collaborators never get `enabled` |
| `pr_approve` | | `disabled` | let the agent submit approving reviews |
| `review_drafts` | | `disabled` | re-review draft PRs in the post-run safety net |
| `setup_script` | | — | runs once after checkout (install dependencies) |
| `post_checkout_script`, `prepush_script`, `stop_script` | | — | lifecycle hooks around the agent's own checkouts and pushes |
| `status_checks` | | `enabled` | post the `reviewx` check-run |
| `approval_check` | | `disabled` | post a `reviewx-approval` verdict check (a merge gate) |
| `progress_comments` | | `enabled` | live task-list updates in the progress comment |
| `env_allowlist` | | — | extra env vars the restricted shell may see |
| `timeout` | | `1h` | maximum run duration |

Example — reviews in Russian, bugs only:

```bash
gh variable set REVIEWX_REVIEW_INSTRUCTIONS -b "Пиши ревью на русском. Фокус: баги, гонки, безопасность. Стиль не комментируй."
```

Repository-level agent config (`CLAUDE.md`, `AGENTS.md`, skills, custom commands, repo MCP servers) is read by the agent as usual.

## Talking to the bot

Mention `@reviewx-bot` in any PR comment or review thread.

- `@reviewx-bot` — review (or re-review) the PR.
- `@reviewx-bot explain the change in src/stats.ts` — answers in a comment.
- `@reviewx-bot fix` — address the open review comments and push.
- `@reviewx-bot --model=anthropic/claude-opus --timeout=2h …` — per-run flags.

## Model keys

### Claude subscription

Run `claude setup-token` locally, paste the printed token into the `CLAUDE_CODE_OAUTH_TOKEN` secret, and set `REVIEWX_MODEL` to an Anthropic model. The token is long-lived; re-run `setup-token` and update the secret when Anthropic revokes it.

### ChatGPT subscription

Run `codex login` locally, then store the contents of `~/.codex/auth.json` in the `CODEX_AUTH_JSON` secret. ReviewX installs it into an isolated `CODEX_HOME` on the runner for the duration of the run. Note the chain rotates on use and ReviewX has nowhere to write the rotated copy back, so refresh the secret when runs start failing with an expired token.

### Grok subscription

Store the Grok CLI's `auth.json` in `GROK_AUTH_JSON`.

### Bedrock

Set `REVIEWX_MODEL` to `bedrock/byok`, `BEDROCK_MODEL_ID` to the Bedrock model id, and the AWS credentials (`AWS_BEARER_TOKEN_BEDROCK` + `AWS_REGION`, or the usual `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`). Anthropic ids route through Claude Code, everything else through OpenCode.

### Vertex

Set `REVIEWX_MODEL` to `vertex/byok`, then `VERTEX_MODEL_ID`, `VERTEX_SERVICE_ACCOUNT_JSON` (the service-account key) and `VERTEX_LOCATION`; `GOOGLE_CLOUD_PROJECT` is read from the key when absent.

### Azure

Set `REVIEWX_MODEL` to `azure/byok`, then `AZURE_RESOURCE_NAME`, `AZURE_DEPLOYMENT` and `AZURE_API_KEY`.

### OpenAI-compatible

Set `REVIEWX_MODEL` to `openai-compatible/byok`, then `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL` and `OPENAI_COMPATIBLE_API_KEY`.

The action prints exactly which variable is missing when any of these setups is incomplete.

## Workflow

The action only needs `id-token: write` and `contents: read`; it never uses the job's `GITHUB_TOKEN` for GitHub operations. If you would rather not use the ReviewX server at all, set `GH_TOKEN` in the step's `env:` (e.g. `${{ github.token }}` with a wider `permissions:` block, or a token from `actions/create-github-app-token`) and the action uses that for everything.

### Self-hosted runners

Shell commands run in a PID-namespace sandbox (`unshare`). On a Kubernetes/ARC runner whose seccomp profile forbids user namespaces the action detects this and disables the shell tool for the run; allow user-namespace creation in the pod to get it back.

## Flags

Flags in a prompt or in instructions: `--model=<slug>`, `--opus` / `--sonnet` / `--haiku`, `--effort=<level>`, `--timeout=<duration>`, `--notimeout`, `--debug`.

## Standalone usage

The same action works as a step in your own workflows with any prompt, no App required:

```yaml
- uses: programistich/reviewx@v1
  with:
    prompt: Generate release notes for ${{ github.ref_name }} and print them via set_output.
  env:
    GH_TOKEN: ${{ github.token }}
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

`prompt_file` reads the prompt from a file; `output_schema` makes the agent return JSON matching a schema in the `result` output.

## Running your own server

The server is stateless: it verifies webhook signatures, decides whether an event starts a run, seeds the progress comment and check-run, dispatches the workflow, and exchanges OIDC tokens for installation tokens. Code in [`server/`](server), deployment in [`deploy/`](deploy).

1. Register a GitHub App with the manifest flow: `pnpm --filter @reviewx/server register https://your.domain --name your-app --public`, open `/setup`, confirm on GitHub. Credentials land in `.local/<slug>.env`.
2. Copy them to `deploy/.env`, then `docker compose -f deploy/docker-compose.yml up -d --build` behind your reverse proxy ([`deploy/Caddyfile.snippet`](deploy/Caddyfile.snippet)).
3. Point the action at it with `API_URL: https://your.domain` in the workflow's `env:`.

## Development

```bash
pnpm install
pnpm typecheck && pnpm test
pnpm --filter @reviewx/action build   # → dist/, committed; CI fails if it is stale
pnpm --filter @reviewx/server dev     # reads server/.local/dev.env (credentials of your own dev App)
```

Releases: run the **Release** workflow with a version; it rebuilds `dist/`, tags `vX.Y.Z` and moves `v1`.

## License

MIT. Copyright Pullfrog, Inc. for the original work and programistich for the ReviewX modifications; see [LICENSE](LICENSE).
