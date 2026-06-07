#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const DEFAULT_BOT_TOKEN_SECRET_ID = "aadcf695-6049-47ac-9d9b-b462006bab90";
const DEFAULT_CHAT_ID_SECRET_ID = "3ebc58f1-644f-4b1c-af95-b462006be9fe";

function readSecretValue(secretId) {
  const raw = execFileSync("bws", ["secret", "get", secretId, "--output", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(raw);
  const value = Array.isArray(parsed) ? parsed[0]?.value : parsed.value;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Bitwarden secret ${secretId} did not contain a value`);
  }
  return value;
}

export function resolveTelegramConfig(env = process.env) {
  const botTokenSecretId =
    env.TELEGRAM_COMPLETION_BOT_TOKEN_SECRET_ID || DEFAULT_BOT_TOKEN_SECRET_ID;
  const chatIdSecretId =
    env.TELEGRAM_COMPLETION_CHAT_ID_SECRET_ID || DEFAULT_CHAT_ID_SECRET_ID;

  if (!env.BWS_ACCESS_TOKEN) {
    throw new Error("BWS_ACCESS_TOKEN is not available to the hook process");
  }

  return {
    botToken: readSecretValue(botTokenSecretId),
    chatId: readSecretValue(chatIdSecretId),
  };
}

export async function sendTelegramMessage(text, env = process.env) {
  const { botToken, chatId } = resolveTelegramConfig(env);
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_notification: false,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) {
    throw new Error(body.description || `Telegram sendMessage failed with HTTP ${response.status}`);
  }
  return {
    ok: true,
    messageId: body.result?.message_id ?? null,
    date: body.result?.date ?? null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = process.argv.slice(2).join(" ").trim();
  if (!text) {
    console.error("usage: send-telegram.mjs <message>");
    process.exit(2);
  }
  sendTelegramMessage(text)
    .then((result) => {
      console.log(JSON.stringify({ ok: true, message_id: result.messageId, date: result.date }));
    })
    .catch((error) => {
      console.error(`[telegram-completion-notifier] ${error.message}`);
      process.exit(1);
    });
}
