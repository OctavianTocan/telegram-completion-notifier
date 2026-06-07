---
name: telegram-notify
description: Send or verify Telegram notifications from Codex using Bitwarden Secrets Manager. Use when the user asks to notify, message, ping, send a Telegram update, verify completion notifications, or inspect the automatic completion-summary hook.
stages: [verify, ship]
---

# Telegram Notify

Send Telegram notifications through the local `telegram-completion-notifier` plugin. Secrets are fetched from Bitwarden Secrets Manager at runtime; do not print or store Telegram token values locally.

The installed Stop hook automatically sends a rich completion summary when a Codex turn finishes. It identifies the sender as Codex plus the local host, derives the session/task name from hook input, transcript metadata, the latest user request, or the workspace name, then includes session ID, workspace, model, duration, request, final-response summary, touched files, and tool counts when available. Telegram messages use HTML formatting for bold labels and code-styled IDs, paths, and model names. Each message includes a `Continue` inline callback button unless `TELEGRAM_COMPLETION_INLINE_KEYBOARD=0`.

## When to Use

Use this skill when the user asks you to send a Telegram notification, test Telegram notification delivery, verify completion notifications, update the automatic completion summary, or inspect inline keyboard callback behavior.

## Variables

- **PLUGIN_ROOT**: `/root/plugins/telegram-completion-notifier`
- **BOT_TOKEN_SECRET_ID**: `aadcf695-6049-47ac-9d9b-b462006bab90`
- **CHAT_ID_SECRET_ID**: `3ebc58f1-644f-4b1c-af95-b462006be9fe`

## Instructions

1. Confirm `BWS_ACCESS_TOKEN` is available without printing it.
2. Confirm `bws` is installed with `bws --version`.
3. Use `scripts/send-telegram.mjs` to send an explicit manual message.
4. Use `scripts/notify-final.mjs` with hook JSON and a transcript path to test the automatic rich summary behavior.
5. Use `scripts/notify-claude-final.mjs` with Claude Code Stop-hook JSON to test Claude Code compatibility.
6. Use `scripts/poll-telegram-actions.mjs` to consume and acknowledge `Continue` callback button clicks; inspect the printed `actions_log` path for recorded actions.
7. Report only the delivery status and Telegram `message_id`; never report secret values.

## Examples

Manual send:

```bash
node /root/plugins/telegram-completion-notifier/scripts/send-telegram.mjs "Codex notification test"
```

Secret-read smoke without values:

```bash
node /root/plugins/telegram-completion-notifier/scripts/send-telegram.mjs "Bitwarden-backed Telegram notification works"
```

Rich Stop-hook smoke:

```bash
printf '{"session_id":"test","session_name":"Manual hook smoke","transcript_path":"/tmp/transcript.jsonl"}' \
  | node /root/plugins/telegram-completion-notifier/scripts/notify-final.mjs
```

Callback poll:

```bash
node /root/plugins/telegram-completion-notifier/scripts/poll-telegram-actions.mjs
```

Claude Code Stop-hook adapter:

```bash
node /root/plugins/telegram-completion-notifier/scripts/notify-claude-final.mjs
```
