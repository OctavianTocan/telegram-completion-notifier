#!/usr/bin/env node
// Claude Code Stop-hook adapter for telegram-completion-notifier.
//
// Unlike the original version, this derives EVERYTHING from the transcript
// (`transcript_path`) rather than from `input.last_assistant_message` — which
// Claude Code's Stop hook does not reliably provide. It builds a Codex-parity
// rich summary (request, final response, files touched, tool-call counts,
// model, duration) and a separate "last AI message" copy, then sends both
// through the shared Bitwarden-backed send-telegram.mjs transport.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { sendTelegramMessage } from "./send-telegram.mjs";

const MAX_TELEGRAM_TEXT = 3900;
const STATE_DIR = join(tmpdir(), "telegram-completion-notifier");
const AUDIT_LOG = join(STATE_DIR, "audit.log");
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// The Stop hook fires before the turn is fully flushed to the transcript, so we
// poll briefly for the trailing assistant record before giving up.
const TRANSCRIPT_ATTEMPTS = 6;
const TRANSCRIPT_DELAY_MS = 350;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logAudit(record) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(AUDIT_LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, {
      flag: "a",
      mode: 0o600,
    });
  } catch {
    // Notification bookkeeping must never block the turn.
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

// ---- transcript parsing -----------------------------------------------------

function parseTranscript(path) {
  if (!path || !existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((record) => record.isSidechain !== true); // skip subagent entries
}

function contentBlocks(record) {
  const content = record?.message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

function recordText(record) {
  return contentBlocks(record)
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function isHumanUser(record) {
  if (record.type !== "user") return false;
  const content = record?.message?.content;
  if (typeof content === "string") return content.trim().length > 0;
  // Tool results come back as `user` records whose content is only tool_result
  // blocks — those are not human prompts.
  return contentBlocks(record).some(
    (block) => block && block.type === "text" && String(block.text || "").trim(),
  );
}

function lastAssistantText(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type === "assistant") {
      const text = recordText(records[i]);
      if (text) return text;
    }
  }
  return "";
}

function lastHumanRequest(records) {
  let latest = "";
  for (const record of records) {
    if (isHumanUser(record)) {
      const text = recordText(record);
      if (text) latest = text;
    }
  }
  return latest;
}

function lastAssistantModel(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type === "assistant" && records[i]?.message?.model) {
      return records[i].message.model;
    }
  }
  return "";
}

function collectToolUsage(records) {
  const counts = {};
  const files = new Set();
  let bashCount = 0;
  let total = 0;
  for (const record of records) {
    if (record.type !== "assistant") continue;
    for (const block of contentBlocks(record)) {
      if (!block || block.type !== "tool_use") continue;
      total += 1;
      const name = block.name || "?";
      counts[name] = (counts[name] || 0) + 1;
      const input = block.input || {};
      if (FILE_EDIT_TOOLS.has(name) && typeof input.file_path === "string") {
        files.add(input.file_path);
      }
      if (name === "Bash") bashCount += 1;
    }
  }
  return { counts, files: [...files], bashCount, total };
}

function formatDuration(records) {
  const stamps = records
    .map((record) => record.timestamp)
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter((value) => !Number.isNaN(value));
  if (stamps.length < 2) return "";
  const ms = Math.max(...stamps) - Math.min(...stamps);
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return remSeconds ? `${minutes}m${String(remSeconds).padStart(2, "0")}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h${String(remMinutes).padStart(2, "0")}m`;
}

// ---- text helpers (parity with notify-final.mjs) ----------------------------

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

function formatToolSummary(counts) {
  const order = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return order.map(([name, count]) => `${name} ${count}`).join(" · ");
}

function formatNotification(input, context) {
  const { requestText, finalText, model, duration, tools, files } = context;
  const sessionId = String(input.session_id || "unknown");
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
  if (duration) lines.push(htmlLine("Duration", duration));
  if (input.hook_event_name) lines.push(htmlLine("Hook", input.hook_event_name, { code: true }));

  if (requestText) {
    lines.push("", "<b>Request</b>", htmlEscape(shortText(requestText, 420)));
  }

  const summaryLines = summarizeFinalText(finalText);
  if (summaryLines.length > 0) {
    lines.push("", "<b>What happened</b>");
    for (const line of summaryLines) lines.push(htmlEscape(shortText(line, 650)));
  }

  if (tools.total > 0 || files.length > 0) {
    lines.push("", "<b>What changed</b>");
    if (files.length > 0) {
      const shown = files.slice(0, 8).map((path) => basename(path));
      const extra = files.length > shown.length ? ` (+${files.length - shown.length} more)` : "";
      lines.push(`${htmlLine("Files", `${shown.join(", ")}${extra}`)}`);
    }
    if (tools.total > 0) {
      lines.push(htmlLine("Tool calls", `${tools.total} — ${formatToolSummary(tools.counts)}`));
    }
  }

  return truncateForTelegram(compactLines(lines).join("\n"));
}

function formatLastAssistantMessage(finalText) {
  const header = compactLines([
    "🟣 <b>Claude Code last AI message</b>",
    "<i>Separate copy of the final assistant response.</i>",
    "",
  ]).join("\n");
  const maxBodyLength = Math.max(200, MAX_TELEGRAM_TEXT - header.length - 40);
  const redacted = redactSecretLikeText(finalText || "").trim();
  const body =
    redacted.length <= maxBodyLength
      ? redacted
      : `${redacted.slice(0, maxBodyLength).trimEnd()}\n\n[truncated for Telegram]`;
  return `${header}\n\n${htmlEscape(body)}`;
}

// ---- de-dupe ----------------------------------------------------------------

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

function markSent(sessionId, textHash, messageIds) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    statePathForSession(sessionId),
    JSON.stringify(
      { lastTextHash: textHash, messageIds, source: "claude-code", ts: new Date().toISOString() },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

// ---- main -------------------------------------------------------------------

async function readTranscriptWithRetry(path) {
  let records = [];
  for (let attempt = 0; attempt < TRANSCRIPT_ATTEMPTS; attempt++) {
    records = parseTranscript(path);
    if (lastAssistantText(records)) return records;
    await sleep(TRANSCRIPT_DELAY_MS);
  }
  return records;
}

async function main() {
  const input = readStdinJson();
  const sessionId = String(input.session_id || "unknown");
  const dryRun = /^(1|true|on|yes)$/i.test(String(process.env.TELEGRAM_DRY_RUN || ""));

  // Loop-prevention guard: Claude sets stop_hook_active when a Stop hook is
  // already running, to avoid recursive/double notifications.
  if (input.stop_hook_active === true) {
    logAudit({ event: "skip", source: "claude-code", reason: "stop-hook-active", sessionId });
    return;
  }

  const records = await readTranscriptWithRetry(input.transcript_path);
  let finalText = lastAssistantText(records);
  // Defensive fallback for hypothetical future versions that DO pass it.
  if (!finalText && typeof input.last_assistant_message === "string") {
    finalText = input.last_assistant_message.trim();
  }
  if (!finalText) {
    logAudit({ event: "skip", source: "claude-code", reason: "no-final-message", sessionId });
    return;
  }

  const textHash = createHash("sha256").update(`${sessionId}\n${finalText}`).digest("hex");
  if (!dryRun && alreadySent(sessionId, textHash)) {
    logAudit({ event: "skip", source: "claude-code", reason: "duplicate", sessionId });
    return;
  }

  const tools = collectToolUsage(records);
  const context = {
    requestText: lastHumanRequest(records),
    finalText,
    model: lastAssistantModel(records) || input.model || process.env.ANTHROPIC_MODEL || "",
    duration: formatDuration(records),
    tools,
    files: tools.files,
  };

  const summaryBody = formatNotification(input, context);
  const lastBody = formatLastAssistantMessage(finalText);

  if (dryRun) {
    console.log("----- summary message -----\n" + summaryBody);
    console.log("\n----- last AI message -----\n" + lastBody);
    logAudit({ event: "dry-run", source: "claude-code", sessionId, files: tools.files.length, tools: tools.total });
    return;
  }

  const result = await sendTelegramMessage(summaryBody, process.env, {
    callbackSeed: `claude:${sessionId}`,
    parseMode: "HTML",
    sessionId,
  });
  const lastMessage = await sendTelegramMessage(lastBody, process.env, {
    callbackSeed: `claude:${sessionId}:last`,
    parseMode: "HTML",
    sessionId,
  });
  const messageIds = { summary: result.messageId, lastAssistantMessage: lastMessage.messageId };
  markSent(sessionId, textHash, messageIds);
  logAudit({ event: "sent", source: "claude-code", sessionId, messageIds, files: tools.files.length, tools: tools.total });
  console.error(
    `[telegram-completion-notifier] sent Claude Code Telegram summary message_id=${result.messageId} last_message_id=${lastMessage.messageId}`,
  );
}

main().catch((error) => {
  logAudit({ event: "error", source: "claude-code", error: error.message });
  console.error(`[telegram-completion-notifier] ${error.message}`);
  process.exit(0);
});
