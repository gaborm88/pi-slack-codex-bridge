# Slack via Codex Bridge for Pi

Expose read-only Slack tools to Pi using the Slack connector already connected in Codex.
Pi's Slack OAuth is not used.
The extension calls Codex's app-server API directly, with no nested model call or copied credentials.

## Install

Requires Node.js 22+, Pi, and a recent Codex CLI supporting `mcpServer/tool/call`.
Check that Slack already works in Codex.

Keep this directory somewhere permanent, then run:

```sh
pi install /absolute/path/to/pi-slack-codex-bridge
```

Run `/reload` in Pi.
For a one-session trial instead, use `pi -e /absolute/path/to/pi-slack-codex-bridge/index.ts`.
No dependency installation is needed; Pi provides the peer dependencies.

## Use

Ask Pi: "Use codex_slack to show the latest messages in #team-rocket."
The model first calls `codex_slack` with `{}` to discover tools and their schemas.
It then calls the same tool with `tool` and `arguments` from that inventory.
Results are the original Slack tool output, not a Codex-generated summary.
Search ordering, pagination, and available history depend on the connected Slack tools.

## Safety and limitations

Only tools identified as Slack with `readOnlyHint: true` and without `destructiveHint: true` are callable.
Missing safety annotations fail closed.
Every call uses a fresh Codex process and ephemeral read-only thread in an empty temporary directory.
No model turn, shell command, file edit, or non-Slack tool is requested.
Interactive approval and authentication requests are rejected, not auto-approved.
Requests time out after 60 seconds and respect Pi cancellation.
Oversized results are saved to a private temporary file, with a preview and file path returned to Pi.
Slack results become part of the Pi conversation and are sent to the current Pi model provider.
Codex retains its own authentication and normal service-side access logging.
The app-server protocol is experimental; future Codex changes may require an update.

## Verify

```sh
node --test codex.test.mjs
```
