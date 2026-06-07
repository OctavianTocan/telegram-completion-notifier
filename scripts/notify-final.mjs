#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
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
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        if (typeof part.input_text === "string") return part.input_text;
        if (typeof part.output_text === "string") return part.output_text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.input_text === "string") return content.input_text;
    if (typeof content.output_text === "string") return content.output_text;
  }
  return "";
}

function payloadOf(entry) {
  return entry?.payload && typeof entry.payload === "object" ? entry.payload : entry;
}

function messageText(entry, wantedRole) {
  const payload = payloadOf(entry);

  if (payload?.type === "message" && payload.role === wantedRole) {
    return textFromContent(payload.content);
  }
  if (payload?.role === wantedRole) {
    return textFromContent(payload.content);
  }
  if (payload?.type === wantedRole && payload.message?.role === wantedRole) {
    return textFromContent(payload.message.content);
  }
  if (payload?.type === wantedRole) {
    return textFromContent(payload.content);
  }
  if (payload?.type === "user_message" && wantedRole === "user") {
    return typeof payload.message === "string" ? payload.message : "";
  }
  if (payload?.type === "agent_message" && wantedRole === "assistant") {
    return typeof payload.message === "string" ? payload.message : "";
  }

  return "";
}

function collectTranscript(entries) {
  const result = {
    sessionMeta: null,
    latestTurnContext: null,
    latestUserText: "",
    latestAssistantText: "",
    latestFinalAssistantText: "",
    latestTaskComplete: null,
    toolCalls: [],
    changedFiles: new Set(),
    startedAt: null,
    completedAt: null,
  };

  for (const entry of entries) {
    const payload = payloadOf(entry);
    if (entry.type === "session_meta") {
      result.sessionMeta = payload;
    }
    if (entry.type === "turn_context") {
      result.latestTurnContext = payload;
    }
    if (payload?.type === "task_started") {
      result.startedAt = payload.started_at || entry.timestamp || result.startedAt;
    }
    if (payload?.type === "task_complete") {
      result.latestTaskComplete = payload;
      result.completedAt = payload.completed_at || entry.timestamp || result.completedAt;
      if (typeof payload.last_agent_message === "string" && payload.last_agent_message.trim()) {
        result.latestFinalAssistantText = payload.last_agent_message.trim();
      }
    }

    const userText = messageText(entry, "user").trim();
    if (userText) result.latestUserText = userText;

    const assistantText = messageText(entry, "assistant").trim();
    if (assistantText) result.latestAssistantText = assistantText;

    if (payload?.type === "function_call" || payload?.type === "custom_tool_call") {
      result.toolCalls.push({
        name: payload.name || "tool",
        arguments: payload.arguments || payload.input || "",
      });
    }

    if (payload?.type === "patch_apply_end" && Array.isArray(payload.changes)) {
      for (const change of payload.changes) {
        const path = change?.path || change?.file || change?.filename;
        if (typeof path === "string" && path.trim()) result.changedFiles.add(path.trim());
      }
    }
  }

  if (!result.latestFinalAssistantText) {
    result.latestFinalAssistantText = result.latestAssistantText;
  }
  return result;
}

function redactSecretLikeText(text) {
  return text
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

function firstMeaningfulLine(text) {
  return (text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .find((line) => line.length > 0) || "";
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

  const sentences = redacted
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 4);
  return sentences.map((sentence) => `- ${sentence}`);
}

function durationSeconds(start, end) {
  const startMs = Date.parse(start || "");
  const endMs = Date.parse(end || "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.round((endMs - startMs) / 1000);
}

function durationFromTranscript(collected) {
  const explicitMs = collected.latestTaskComplete?.duration_ms;
  if (Number.isFinite(explicitMs) && explicitMs >= 0) {
    return Math.round(explicitMs / 1000);
  }
  return durationSeconds(collected.startedAt, collected.completedAt);
}

function formatModel(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  if (typeof model === "object") {
    const candidate = model.id || model.model || model.name || model.slug;
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return "";
}

function toolSummary(toolCalls) {
  const counts = new Map();
  for (const call of toolCalls) {
    counts.set(call.name, (counts.get(call.name) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([name, count]) => `${name} x${count}`);
}

function deriveSessionName(input, collected) {
  const explicit =
    input.session_name ||
    input.conversation_title ||
    input.thread_title ||
    collected.sessionMeta?.title ||
    collected.latestTurnContext?.title;
  if (typeof explicit === "string" && explicit.trim()) return shortText(explicit, 80);

  const fromPrompt = firstMeaningfulLine(collected.latestUserText);
  if (fromPrompt) return shortText(fromPrompt, 80);

  const cwd = collected.latestTurnContext?.cwd || collected.sessionMeta?.cwd || input.cwd;
  if (typeof cwd === "string" && cwd.trim()) return basename(cwd) || cwd;

  return "Codex session";
}

function formatNotification(input, collected) {
  const sessionId = String(
    input.session_id ||
      input.conversation_id ||
      collected.sessionMeta?.id ||
      collected.latestTurnContext?.turn_id ||
      "unknown",
  );
  const cwd = collected.latestTurnContext?.cwd || collected.sessionMeta?.cwd || input.cwd || "";
  const model = formatModel(collected.latestTurnContext?.model || collected.sessionMeta?.model);
  const duration = durationFromTranscript(collected);
  const title = deriveSessionName(input, collected);
  const summaryLines = summarizeFinalText(collected.latestFinalAssistantText);
  const tools = toolSummary(collected.toolCalls);
  const changedFiles = [...collected.changedFiles].slice(0, 6);

  const lines = [
    "Codex completion summary",
    "",
    `Session: ${title}`,
    `ID: ${sessionId.slice(0, 12)}${sessionId.length > 12 ? "..." : ""}`,
  ];
  if (cwd) lines.push(`Workspace: ${cwd}`);
  if (model) lines.push(`Model: ${model}`);
  if (duration !== null) lines.push(`Duration: ${duration}s`);

  if (collected.latestUserText) {
    lines.push("", "Request:", shortText(collected.latestUserText, 420));
  }

  if (summaryLines.length > 0) {
    lines.push("", "What happened:");
    for (const line of summaryLines) lines.push(shortText(line, 650));
  }

  if (changedFiles.length > 0) {
    lines.push("", "Files touched:");
    for (const file of changedFiles) lines.push(`- ${file}`);
    if (collected.changedFiles.size > changedFiles.length) {
      lines.push(`- ...and ${collected.changedFiles.size - changedFiles.length} more`);
    }
  }

  if (tools.length > 0) {
    lines.push("", `Tools: ${tools.join(", ")}`);
  }

  return truncateForTelegram(lines.join("\n"));
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
  const entries = readTranscriptEntries(transcriptPath);
  const collected = collectTranscript(entries);
  const finalText = collected.latestFinalAssistantText;

  if (!finalText) {
    logAudit({ event: "skip", reason: "no-final-assistant-message", sessionId });
    return;
  }

  const textHash = createHash("sha256").update(`${sessionId}\n${finalText}`).digest("hex");
  if (alreadySent(sessionId, textHash)) {
    logAudit({ event: "skip", reason: "duplicate", sessionId });
    return;
  }

  const body = formatNotification(input, collected);
  const result = await sendTelegramMessage(body);
  markSent(sessionId, textHash, result.messageId);
  logAudit({ event: "sent", sessionId, messageId: result.messageId, rich: true });
  console.error(`[telegram-completion-notifier] sent rich Telegram summary message_id=${result.messageId}`);
}

main().catch((error) => {
  logAudit({ event: "error", error: error.message });
  console.error(`[telegram-completion-notifier] ${error.message}`);
  process.exit(0);
});
