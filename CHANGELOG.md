# Changelog

## Unreleased

- Send rich completion summaries with session metadata, request context, final-response summary, touched files, and tool counts.
- Format Telegram messages with HTML and include source/agent identity for shared notification chats.
- Add a default `Continue` inline keyboard button plus a callback poller that acknowledges and records continue requests.
- Add a Claude Code Stop-hook adapter and example settings file using the same Telegram transport.
- Send a second, separately labeled last-AI-message Telegram copy for both Codex and Claude Code completions.

## 0.1.0

- Initial local plugin with Bitwarden-backed Telegram Stop-hook notifications.
