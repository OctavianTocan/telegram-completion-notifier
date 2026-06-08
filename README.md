# Telegram Completion Notifier

> Codex **and Claude Code** Stop-hook notifications to Telegram, backed by Bitwarden Secrets Manager.

## What It Does

This local Codex plugin sends a Telegram notification when a Codex turn finishes. The Stop hook reads Codex's rollout transcript, fetches the Telegram bot token and chat ID from Bitwarden Secrets Manager with `bws`, and sends a rich completion summary.

The summary includes:

- source identity (`From`) and agent identity (`Codex`) for shared notification chats
- session title or derived request name
- session ID, workspace, model, and duration when available
- the latest user request
- a short summary of the final assistant response
- files touched by patch events
- tool-call counts
- an inline keyboard with a `Continue` callback button on every message
- a second, separate message containing the last AI response, labeled with
  `🤖 Codex last AI message` or `🟣 Claude Code last AI message`

The plugin does not store Telegram secrets locally. It expects `BWS_ACCESS_TOKEN` to be available in the shell environment and keeps only Bitwarden secret IDs in source.

The Codex Stop hook is intentionally awaited rather than async: Codex currently skips async hook handlers, and this notifier must finish its Bitwarden lookup and Telegram sends before the turn process exits.

## Structure

```text
telegram-completion-notifier/
├── .claude-plugin/plugin.json        # Claude Code plugin manifest
├── .claude-plugin/marketplace.json   # local marketplace entry
├── .codex-plugin/plugin.json         # Codex plugin manifest
├── claude/settings.example.json
├── hooks/hooks.json                  # Claude Code Stop hook
├── hooks/codex-hooks.json            # Codex Stop hook
├── scripts/notify-claude-final.mjs   # Claude Code adapter (transcript-derived)
├── scripts/notify-final.mjs          # Codex adapter
├── scripts/poll-telegram-actions.mjs
├── scripts/send-telegram.mjs         # shared Telegram transport
└── skills/telegram-notify/SKILL.md
```

## Setup

Required runtime pieces:

- `bws` on `PATH`
- `BWS_ACCESS_TOKEN` exported in the Codex process environment
- Bitwarden secrets for Telegram bot token and chat ID

Default Bitwarden secret IDs:

```text
bot token: aadcf695-6049-47ac-9d9b-b462006bab90
chat id:   3ebc58f1-644f-4b1c-af95-b462006be9fe
```

Override them with:

```bash
export TELEGRAM_COMPLETION_BOT_TOKEN_SECRET_ID="..."
export TELEGRAM_COMPLETION_CHAT_ID_SECRET_ID="..."
```

Optional inline-keyboard settings:

```bash
# Disable buttons entirely.
export TELEGRAM_COMPLETION_INLINE_KEYBOARD=0

# Add a second URL button next to Continue.
# Telegram accepts HTTP(S) and tg:// button URLs.
export TELEGRAM_COMPLETION_OPEN_URL="https://example.com/open-codex"
export TELEGRAM_COMPLETION_OPEN_LABEL="Open Codex"
export TELEGRAM_COMPLETION_CONTINUE_LABEL="Continue"
```

## Manual Test

Send a plain manual message:

```bash
node scripts/send-telegram.mjs "Codex Telegram notification test"
```

Expected output:

```json
{"ok":true,"message_id":123,"date":1780814666}
```

Run the Stop hook against a Codex transcript by piping hook JSON:

```bash
printf '{"session_id":"test","session_name":"Manual hook smoke","transcript_path":"/path/to/transcript.jsonl"}' \
  | node scripts/notify-final.mjs
```

Poll and acknowledge inline keyboard callbacks:

```bash
node scripts/poll-telegram-actions.mjs
```

The poller records `Continue` clicks in:

```text
<os-temp-dir>/telegram-completion-notifier/actions.jsonl
```

The poller prints the actual `actions_log` path after each run.

## Notes

- The Stop hook de-dupes repeated sends per session and final message hash.
- The Codex Stop hook uses Codex's plugin-provided `PLUGIN_ROOT` environment variable to locate `scripts/notify-final.mjs`.
- Telegram messages use HTML formatting for bold labels and code-styled IDs, paths, and model names.
- Every completion sends a summary message followed by a separate last-AI-message copy.
- The `Continue` button is a Telegram callback button. It needs `scripts/poll-telegram-actions.mjs`, a cron, a daemon, or a webhook to consume callbacks. Without a receiver, Telegram stores the callback update but no Codex action runs.
- Pressing `Continue` currently records and acknowledges the request. Actually resuming a Codex session should be wired through a deliberately trusted bridge such as Codex remote-control, an app-server endpoint, or a controlled `codex resume` worker.
- Token-shaped strings in request and response text are redacted before sending.
- Runtime audit logs live under `<os-temp-dir>/telegram-completion-notifier/audit.log` and contain only status, timestamps, session IDs, and Telegram message IDs.

## Claude Code support

This is a **dual-harness plugin**: the same repo serves both Codex and Claude Code, sharing `scripts/send-telegram.mjs` and the same Bitwarden-backed Telegram credentials.

The Claude Code adapter (`scripts/notify-claude-final.mjs`) derives everything from the session **transcript** (`transcript_path`) — the latest request, the final assistant response, files touched, tool-call counts, model, and duration. It does **not** depend on `last_assistant_message` (Claude Code's Stop hook does not reliably provide it); it guards re-entrancy with `stop_hook_active` and the pre-flush read race with a short retry. A `TELEGRAM_DRY_RUN=1` env var prints the composed messages instead of sending.

Stop-hook input fields it relies on: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `stop_hook_active`.

### Hooks layout (dual harness)

| Harness | Manifest | Hooks file |
| --- | --- | --- |
| Claude Code | `.claude-plugin/plugin.json` (no `hooks` field) | `hooks/hooks.json` (auto-discovered) → `notify-claude-final.mjs` via `${CLAUDE_PLUGIN_ROOT}` |
| Codex | `.codex-plugin/plugin.json` (`"hooks": "./hooks/codex-hooks.json"`) | `hooks/codex-hooks.json` → `notify-final.mjs` via `${PLUGIN_ROOT}` |

### Install for Claude Code

```bash
claude plugin marketplace add /path/to/telegram-completion-notifier
claude plugin install telegram-completion-notifier@telegram-completion-notifier --scope user
```

`bws` must be on `PATH` and `BWS_ACCESS_TOKEN` exported in the environment Claude Code runs in. The hook then fires on every turn end (new sessions), sending a `Claude Code completion summary` plus a separate `🟣 Claude Code last AI message`. A manual user-level `.claude/settings.json` Stop hook is also possible (see `claude/settings.example.json`), but the plugin install above is preferred — portable, no hardcoded paths.

## Repository

GitHub: <https://github.com/OctavianTocan/telegram-completion-notifier>
