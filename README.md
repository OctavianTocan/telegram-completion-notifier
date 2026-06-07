# Telegram Completion Notifier

> Codex Stop-hook notifications to Telegram, backed by Bitwarden Secrets Manager.

## What It Does

This local Codex plugin sends a Telegram notification when a Codex turn finishes. The hook reads the final assistant response from the hook transcript, fetches the Telegram bot token and chat ID from Bitwarden Secrets Manager with `bws`, and sends a concise completion message.

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

```bash
node scripts/send-telegram.mjs "Codex Telegram notification test"
```

Expected output:

```json
{"ok":true,"message_id":123,"date":1780814666}
```

## Notes

- The Stop hook de-dupes repeated sends per session and final message hash.
- Token-shaped strings in final assistant text are redacted before sending.
- Runtime audit logs live under `/tmp/telegram-completion-notifier/audit.log` and contain only status, timestamps, session IDs, and Telegram message IDs.

## Repository

GitHub: <https://github.com/OctavianTocan/telegram-completion-notifier>
