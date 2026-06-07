---
name: telegram-notify
description: Send a Telegram notification from Codex using Bitwarden Secrets Manager. Use when the user asks to notify, message, ping, send a Telegram update, or verify completion notifications.
stages: [verify, ship]
---

# Telegram Notify

Send Telegram notifications through the local `telegram-completion-notifier` plugin. Secrets are fetched from Bitwarden Secrets Manager at runtime; do not print or store Telegram token values locally.

## When to Use

Use this skill when the user asks you to send a Telegram notification, test Telegram notification delivery, or verify that completion notifications work.

## Variables

- **PLUGIN_ROOT**: `/root/plugins/telegram-completion-notifier`
- **BOT_TOKEN_SECRET_ID**: `aadcf695-6049-47ac-9d9b-b462006bab90`
- **CHAT_ID_SECRET_ID**: `3ebc58f1-644f-4b1c-af95-b462006be9fe`

## Instructions

1. Confirm `BWS_ACCESS_TOKEN` is available without printing it.
2. Confirm `bws` is installed with `bws --version`.
3. Use `scripts/send-telegram.mjs` to send the requested text.
4. Report only the delivery status and Telegram `message_id`; never report secret values.

## Examples

Manual send:

```bash
node /root/plugins/telegram-completion-notifier/scripts/send-telegram.mjs "Codex notification test"
```

Secret-read smoke without values:

```bash
node /root/plugins/telegram-completion-notifier/scripts/send-telegram.mjs "Bitwarden-backed Telegram notification works"
```
