#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveTelegramConfig } from "./send-telegram.mjs";

const STATE_DIR = join(tmpdir(), "telegram-completion-notifier");
const OFFSET_FILE = join(STATE_DIR, "telegram-update-offset");
const ACTIONS_LOG = join(STATE_DIR, "actions.jsonl");

function readOffset() {
  try {
    const parsed = Number.parseInt(readFileSync(OFFSET_FILE, "utf8").trim(), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeOffset(offset) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(OFFSET_FILE, `${offset}\n`, { mode: 0o600 });
}

function appendAction(action) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(ACTIONS_LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...action })}\n`, {
    flag: "a",
    mode: 0o600,
  });
}

async function telegramRequest(botToken, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.description || `${method} failed with HTTP ${response.status}`);
  }
  return payload.result;
}

function callbackChatId(callbackQuery) {
  return String(callbackQuery?.message?.chat?.id || callbackQuery?.from?.id || "");
}

function parseContinueData(data) {
  const prefix = "tcn:continue:";
  if (!data.startsWith(prefix)) return null;
  return data.slice(prefix.length) || null;
}

async function handleCallback(botToken, expectedChatId, callbackQuery) {
  const data = String(callbackQuery?.data || "");
  const sessionRef = parseContinueData(data);
  if (!sessionRef) return false;

  const chatId = callbackChatId(callbackQuery);
  if (expectedChatId && chatId !== String(expectedChatId)) {
    await telegramRequest(botToken, "answerCallbackQuery", {
      callback_query_id: callbackQuery.id,
      text: "This Continue button belongs to a different configured chat.",
      show_alert: false,
    });
    appendAction({ event: "ignored-chat", action: "continue", chatId, expectedChatId });
    return true;
  }

  appendAction({
    event: "requested",
    action: "continue",
    callbackData: data,
    sessionRef,
    chatId,
    fromId: callbackQuery?.from?.id || null,
    messageId: callbackQuery?.message?.message_id || null,
    host: hostname(),
  });

  await telegramRequest(botToken, "answerCallbackQuery", {
    callback_query_id: callbackQuery.id,
    text: `Continue request recorded by Codex on ${hostname()}.`,
    show_alert: false,
  });
  return true;
}

async function pollOnce() {
  const { botToken, chatId } = resolveTelegramConfig();
  const offset = readOffset();
  const updates = await telegramRequest(botToken, "getUpdates", {
    allowed_updates: ["callback_query"],
    limit: 25,
    offset,
    timeout: 0,
  });

  let handled = 0;
  let nextOffset = offset;
  for (const update of updates) {
    nextOffset = Math.max(nextOffset || 0, update.update_id + 1);
    if (update.callback_query && (await handleCallback(botToken, chatId, update.callback_query))) {
      handled += 1;
    }
  }
  if (nextOffset !== undefined) writeOffset(nextOffset);
  return { updates: updates.length, handled, offset: nextOffset };
}

pollOnce()
  .then((result) => {
    console.log(JSON.stringify({ ok: true, ...result, actions_log: ACTIONS_LOG }));
  })
  .catch((error) => {
    console.error(`[telegram-completion-notifier] ${error.message}`);
    process.exit(1);
  });
