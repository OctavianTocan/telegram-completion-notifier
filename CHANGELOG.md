# Changelog

## 0.2.0

- Package as a **dual-harness plugin**: add a Claude Code plugin manifest (`.claude-plugin/plugin.json`) and a local `marketplace.json`; route Codex hooks to `hooks/codex-hooks.json` and Claude Code hooks to `hooks/hooks.json` (auto-discovered, `${CLAUDE_PLUGIN_ROOT}`).
- Rewrite the Claude Code adapter to derive the summary entirely from the transcript (request, final response, files touched, tool counts, model, duration); drop the unreliable `last_assistant_message` dependency; add a `stop_hook_active` guard and a transcript pre-flush read retry.
- Fix Bitwarden secret reads when `FORCE_COLOR`/`COLORTERM` is set: force color off for `bws` and strip ANSI before `JSON.parse` (previously broke the Telegram send).
- Add a `TELEGRAM_DRY_RUN` mode to the Claude Code adapter for safe testing.

## Unreleased

- Make the Codex Stop hook awaited, use Codex's supported `PLUGIN_ROOT` hook environment, and raise the timeout to 45 seconds so automatic notifications actually run.
- Send rich completion summaries with session metadata, request context, final-response summary, touched files, and tool counts.
- Format Telegram messages with HTML and include source/agent identity for shared notification chats.
- Add a default `Continue` inline keyboard button plus a callback poller that acknowledges and records continue requests.
- Add a Claude Code Stop-hook adapter and example settings file using the same Telegram transport.
- Send a second, separately labeled last-AI-message Telegram copy for both Codex and Claude Code completions.

## 0.1.0

- Initial local plugin with Bitwarden-backed Telegram Stop-hook notifications.
