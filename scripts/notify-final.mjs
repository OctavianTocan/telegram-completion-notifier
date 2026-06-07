#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    // Audit logging must never block completion.
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

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function assistantTextFromEntry(entry) {
  if (!entry || typeof entry !== "object") return "";

  if (entry.type === "assistant" && entry.message?.role === "assistant") {
    return textFromContent(entry.message.content);
  }
  if (entry.role === "assistant") {
    return textFromContent(entry.content);
  }
  if (entry.type === "assistant") {
    return textFromContent(entry.content);
  }
  if (entry.type === "response_item" && entry.item?.role === "assistant") {
    return textFromContent(entry.item.content);
  }
  if (entry.item?.type === "message" && entry.item?.role === "assistant") {
    return textFromContent(entry.item.content);
  }

  return "";
}

function readFinalAssistantMessage(transcriptPath) {
  if (!transcriptPath) return "";
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/);
  } catch {
    return "";
  }

  let latest = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const text = assistantTextFromEntry(entry).trim();
      if (text) latest = text;
    } catch {
      // Ignore malformed transcript rows.
    }
  }
  return latest;
}

function redactSecretLikeText(text) {
  return text
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-telegram-token]")
    .replace(/\b0\.[A-Za-z0-9-]+\.[A-Za-z0-9:_+/=-]{20,}\b/g, "[redacted-bws-token]")
    .replace(/\b[A-Za-z0-9_=-]{48,}\b/g, "[redacted-token]");
}

function truncateForTelegram(text) {
  if (text.length <= MAX_TELEGRAM_TEXT) return text;
  return `${text.slice(0, MAX_TELEGRAM_TEXT - 80).trimEnd()}\n\n[truncated for Telegram]`;
}

function statePathForSession(sessionId) {
  const safeId = createHash("sha256").update(sessionId || "unknown").digest("hex");
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
    JSON.stringify({ lastTextHash: textHash, messageId, ts: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
}

async function main() {
  const input = readStdinJson();
  const sessionId = String(input.session_id || input.conversation_id || "unknown");
  const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";
  const finalText = readFinalAssistantMessage(transcriptPath);

  if (!finalText) {
    logAudit({ event: "skip", reason: "no-final-assistant-message", sessionId });
    return;
  }

  const textHash = createHash("sha256").update(finalText).digest("hex");
  if (alreadySent(sessionId, textHash)) {
    logAudit({ event: "skip", reason: "duplicate", sessionId });
    return;
  }

  const body = truncateForTelegram(
    `Codex completed:\n\n${redactSecretLikeText(finalText)}`,
  );
  const result = await sendTelegramMessage(body);
  markSent(sessionId, textHash, result.messageId);
  logAudit({ event: "sent", sessionId, messageId: result.messageId });
  console.error(`[telegram-completion-notifier] sent Telegram message_id=${result.messageId}`);
}

main().catch((error) => {
  logAudit({ event: "error", error: error.message });
  console.error(`[telegram-completion-notifier] ${error.message}`);
  process.exit(0);
});
