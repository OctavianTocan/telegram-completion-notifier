#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { sendTelegramMessage } from "./send-telegram.mjs";

const MAX_TELEGRAM_TEXT = 3900;
const STATE_DIR = join(tmpdir(), "telegram-completion-notifier");
const AUDIT_LOG = join(STATE_DIR, "audit.log");

function logAudit(record) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(AUDIT_LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, {
      flag: "a",
      mode: 0o600,
    });
  } catch {
    // Notification failures should be reportable, not blocking.
  }
}

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function readTranscriptEntries(transcriptPath) {
  if (!transcriptPath) return [];
  try {
    return readFileSync(transcriptPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        return part.text || part.content || "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") return content.text || content.content || "";
  return "";
}

function messageText(entry, wantedRole) {
  const payload = entry?.payload && typeof entry.payload === "object" ? entry.payload : entry;
  if (payload?.role === wantedRole) return textFromContent(payload.content);
  if (payload?.message?.role === wantedRole) return textFromContent(payload.message.content);
  if (payload?.type === wantedRole) return textFromContent(payload.content || payload.message?.content);
  return "";
}

function latestUserText(entries) {
  let latest = "";
  for (const entry of entries) {
    const text = messageText(entry, "user").trim();
    if (text) latest = text;
  }
  return latest;
}

function redactSecretLikeText(text) {
  return String(text || "")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-telegram-token]")
    .replace(/\b0\.[A-Za-z0-9-]+\.[A-Za-z0-9:_+/=-]{20,}\b/g, "[redacted-bws-token]")
    .replace(/\b[A-Za-z0-9_=-]{48,}\b/g, "[redacted-token]");
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function shortText(text, maxLength) {
  const normalized = normalizeWhitespace(redactSecretLikeText(text || ""));
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function htmlEscape(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlLine(label, value, { code = false } = {}) {
  if (!value) return "";
  const rendered = code ? `<code>${htmlEscape(value)}</code>` : htmlEscape(value);
  return `<b>${htmlEscape(label)}</b>: ${rendered}`;
}

function summarizeFinalText(text) {
  const redacted = redactSecretLikeText(text || "").trim();
  const bulletLines = redacted
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line) || /^\d+[.)]\s+\S/.test(line))
    .map((line) => line.replace(/^\d+[.)]\s+/, "- ").replace(/^[-*]\s+/, "- "))
    .slice(0, 5);
  if (bulletLines.length > 0) return bulletLines;

  return redacted
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((sentence) => `- ${sentence}`);
}

function taskName(input, requestText) {
  const explicit = input.session_name || input.conversation_title || input.thread_title;
  if (typeof explicit === "string" && explicit.trim()) return shortText(explicit, 80);
  if (requestText) return shortText(requestText.split(/\r?\n/).find(Boolean) || requestText, 80);
  if (typeof input.cwd === "string" && input.cwd.trim()) return basename(input.cwd) || input.cwd;
  return "Claude Code session";
}

function compactLines(lines) {
  const compacted = [];
  let previousBlank = false;
  for (const line of lines) {
    if (line === null || line === undefined) continue;
    if (line === "") {
      if (!previousBlank && compacted.length > 0) compacted.push("");
      previousBlank = true;
      continue;
    }
    compacted.push(line);
    previousBlank = false;
  }
  while (compacted[compacted.length - 1] === "") compacted.pop();
  return compacted;
}

function truncateForTelegram(text) {
  if (text.length <= MAX_TELEGRAM_TEXT) return text;
  return `${text.slice(0, MAX_TELEGRAM_TEXT - 80).trimEnd()}\n\n[truncated for Telegram]`;
}

function formatNotification(input, requestText, finalText) {
  const sessionId = String(input.session_id || "unknown");
  const model = input.model || process.env.CLAUDE_CODE_MODEL || process.env.ANTHROPIC_MODEL || "";
  const summaryLines = summarizeFinalText(finalText);
  const lines = [
    "<b>Claude Code completion summary</b>",
    "",
    htmlLine("From", `Claude Code on ${hostname()}`),
    htmlLine("Agent", "Claude Code"),
    htmlLine("Task", taskName(input, requestText)),
    htmlLine("ID", `${sessionId.slice(0, 12)}${sessionId.length > 12 ? "..." : ""}`, { code: true }),
  ];
  if (input.cwd) lines.push(htmlLine("Workspace", input.cwd, { code: true }));
  if (model) lines.push(htmlLine("Model", model, { code: true }));
  if (input.hook_event_name) lines.push(htmlLine("Hook", input.hook_event_name, { code: true }));

  if (requestText) {
    lines.push("", "<b>Request</b>", htmlEscape(shortText(requestText, 420)));
  }

  if (summaryLines.length > 0) {
    lines.push("", "<b>What happened</b>");
    for (const line of summaryLines) lines.push(htmlEscape(shortText(line, 650)));
  }

  return truncateForTelegram(compactLines(lines).join("\n"));
}

function statePathForSession(sessionId) {
  const safeId = createHash("sha256").update(`claude:${sessionId || "unknown"}`).digest("hex");
  return join(STATE_DIR, `${safeId}.json`);
}

function alreadySent(sessionId, textHash) {
  try {
    const state = JSON.parse(readFileSync(statePathForSession(sessionId), "utf8"));
    return state?.lastTextHash === textHash;
  } catch {
    return false;
  }
}

function markSent(sessionId, textHash, messageId) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    statePathForSession(sessionId),
    JSON.stringify({ lastTextHash: textHash, messageId, source: "claude-code", ts: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
}

async function main() {
  const input = readStdinJson();
  const sessionId = String(input.session_id || "unknown");
  const finalText = typeof input.last_assistant_message === "string" ? input.last_assistant_message.trim() : "";
  if (!finalText) {
    logAudit({ event: "skip", source: "claude-code", reason: "no-last-assistant-message", sessionId });
    return;
  }

  const requestText = latestUserText(readTranscriptEntries(input.transcript_path));
  const textHash = createHash("sha256").update(`${sessionId}\n${finalText}`).digest("hex");
  if (alreadySent(sessionId, textHash)) {
    logAudit({ event: "skip", source: "claude-code", reason: "duplicate", sessionId });
    return;
  }

  const body = formatNotification(input, requestText, finalText);
  const result = await sendTelegramMessage(body, process.env, {
    callbackSeed: `claude:${sessionId}`,
    parseMode: "HTML",
    sessionId,
  });
  markSent(sessionId, textHash, result.messageId);
  logAudit({ event: "sent", source: "claude-code", sessionId, messageId: result.messageId, rich: true });
  console.error(`[telegram-completion-notifier] sent Claude Code Telegram summary message_id=${result.messageId}`);
}

main().catch((error) => {
  logAudit({ event: "error", source: "claude-code", error: error.message });
  console.error(`[telegram-completion-notifier] ${error.message}`);
  process.exit(0);
});
