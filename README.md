# Telegram Completion Notifier

> Codex Stop-hook notifications to Telegram, backed by Bitwarden Secrets Manager.

## What It Does

This local Codex plugin sends a Telegram notification when a Codex turn finishes. The Stop hook reads Codex's rollout transcript, fetches the Telegram bot token and chat ID from Bitwarden Secrets Manager with `bws`, and sends a rich completion summary.

The summary includes:

- session title or derived request name
- session ID, workspace, model, and duration when available
- the latest user request
- a short summary of the final assistant response
- files touched by patch events
- tool-call counts

The plugin does not store Telegram secrets locally. It expects `BWS_ACCESS_TOKEN` to be available in the shell environment and keeps only Bitwarden secret IDs in source.

## Structure

```text
telegram-completion-notifier/
├── .codex-plugin/plugin.json
├── hooks/hooks.json
├── scripts/notify-final.mjs
├── scripts/send-telegram.mjs
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

## Notes

- The Stop hook de-dupes repeated sends per session and final message hash.
- Token-shaped strings in request and response text are redacted before sending.
- Runtime audit logs live under `/tmp/telegram-completion-notifier/audit.log` and contain only status, timestamps, session IDs, and Telegram message IDs.

## Repository

GitHub: <https://github.com/OctavianTocan/telegram-completion-notifier>
