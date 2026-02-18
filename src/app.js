/**
 * OpenCode ↔ Slack Bridge
 *
 * A Slack bot that lets you interact with OpenCode from Slack threads.
 * - Mention @opencode or DM the bot to start a conversation
 * - Reply in the thread to continue the same session
 * - Set working directory per-conversation with:  dir:/path/to/project
 * - Every tool call, file change, and response streams in real-time
 */

import "dotenv/config";
import path from "node:path";
import pkg from "@slack/bolt";
const { App } = pkg;
import { runOpencode } from "./opencode.js";
import { createAccumulator } from "./formatter.js";
import { getThread, upsertThread } from "./store.js";

// ── Config ──────────────────────────────────────────────────────────────

const SLACK_BOT_TOKEN = requiredEnv("SLACK_BOT_TOKEN");
const SLACK_APP_TOKEN = requiredEnv("SLACK_APP_TOKEN");
const SLACK_SIGNING_SECRET = requiredEnv("SLACK_SIGNING_SECRET");
const ALLOWED_USER_ID = requiredEnv("ALLOWED_USER_ID");
const DEFAULT_DIR = process.env.OPENCODE_DEFAULT_DIR || process.cwd();

// How often to update the Slack message while streaming (ms)
const UPDATE_INTERVAL = 1500;

// Track active child processes for graceful shutdown
const activeProcesses = new Set();

// ── Bolt App ────────────────────────────────────────────────────────────

const bolt = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  socketMode: true,
});

// ── Auth guard ──────────────────────────────────────────────────────────

function isAllowed(userId) {
  return userId === ALLOWED_USER_ID;
}

// ── Handle app_mention events ───────────────────────────────────────────

bolt.event("app_mention", async ({ event, client, say }) => {
  console.log("[app_mention]", JSON.stringify({ user: event.user, text: event.text?.slice(0, 80) }));
  if (!isAllowed(event.user)) {
    await say({ text: "Sorry, you're not authorized to use this bot.", thread_ts: event.ts });
    return;
  }

  // Strip the bot mention from the text
  const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!text) {
    await say({ text: "Send me a message and I'll pass it to OpenCode!", thread_ts: event.ts });
    return;
  }

  const threadTs = event.thread_ts || event.ts;
  await handleMessage({ text, threadTs, channel: event.channel, client });
});

// ── Handle DMs and thread replies ────────────────────────────────────────

bolt.event("message", async ({ event, client }) => {
  console.log("[message event]", JSON.stringify({
    type: event.type,
    subtype: event.subtype,
    channel_type: event.channel_type,
    user: event.user,
    bot_id: event.bot_id,
    text: event.text?.slice(0, 80),
    thread_ts: event.thread_ts,
    ts: event.ts,
  }));

  // Skip bot messages, message_changed, etc.
  if (event.subtype) return;
  if (event.bot_id) return;
  if (!event.text) return;
  if (!isAllowed(event.user)) return;

  // Check if this is a DM
  const isDM = event.channel_type === "im";
  // Check if this is a thread reply (in a channel where we're already active)
  const isThreadReply = event.thread_ts && event.thread_ts !== event.ts;

  if (!isDM && !isThreadReply) return;

  // For thread replies, only respond if we have an active session for this thread
  if (isThreadReply) {
    const thread = getThread(event.thread_ts);
    if (!thread) return; // Not our thread
  }

  const threadTs = event.thread_ts || event.ts;
  const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!text) return;

  console.log("[handling message]", text.slice(0, 80), "thread:", threadTs);
  await handleMessage({ text, threadTs, channel: event.channel, client });
});

// ── Core: send message to OpenCode, stream response back ────────────────

async function handleMessage({ text, threadTs, channel, client }) {
  // Parse directives from the message
  const { message, directory } = parseDirectives(text);
  if (!message) return;

  // Get or create thread state
  let thread = getThread(threadTs);

  if (directory) {
    thread = upsertThread(threadTs, { directory });
  }

  if (!thread) {
    thread = upsertThread(threadTs, { directory: directory || DEFAULT_DIR });
  }

  // Queue if busy
  if (thread.busy) {
    thread.queue.push(message);
    upsertThread(threadTs, { queue: thread.queue });
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `_Queued — waiting for current request to finish..._`,
    });
    return;
  }

  upsertThread(threadTs, { busy: true });

  await processMessage({ message, threadTs, channel, client });

  // Drain queue
  let queued = getThread(threadTs)?.queue ?? [];
  while (queued.length > 0) {
    const next = queued.shift();
    upsertThread(threadTs, { queue: queued });
    await processMessage({ message: next, threadTs, channel, client });
    queued = getThread(threadTs)?.queue ?? [];
  }

  upsertThread(threadTs, { busy: false });
}

async function processMessage({ message, threadTs, channel, client }) {
  const thread = getThread(threadTs);
  const accumulator = createAccumulator();

  // Post initial "thinking" message
  const initial = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "Processing...",
    blocks: accumulator.blocks(),
  });
  const messageTs = initial.ts;

  // Throttled Slack update
  let updatePending = false;
  let updateTimer = null;

  const scheduleUpdate = () => {
    if (updatePending) return;
    updatePending = true;
    updateTimer = setTimeout(async () => {
      updatePending = false;
      try {
        await client.chat.update({
          channel,
          ts: messageTs,
          text: "OpenCode response",
          blocks: accumulator.blocks(),
        });
      } catch (err) {
        // Rate limit or other Slack error — just skip this update
        if (err?.data?.error === "ratelimited") {
          // Back off and retry on next event
        } else {
          console.error("[slack update error]", err?.data?.error ?? err.message);
        }
      }
    }, UPDATE_INTERVAL);
  };

  // Run opencode
  const emitter = runOpencode({
    message,
    sessionID: thread.sessionID,
    directory: thread.directory,
  });

  activeProcesses.add(emitter);

  return new Promise((resolve) => {
    emitter.on("event", (event) => {
      console.log("[opencode event]", event.type, event.part?.type ?? "");
      accumulator.push(event);
      scheduleUpdate();
    });

    emitter.on("stderr", (txt) => {
      console.error("[opencode stderr]", txt);
    });

    emitter.on("error", async (err) => {
      console.error("[opencode error]", err);
      activeProcesses.delete(emitter);
      if (updateTimer) clearTimeout(updateTimer);
      try {
        await client.chat.update({
          channel,
          ts: messageTs,
          text: `Error: ${err.message}`,
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: `:x: *OpenCode error:*\n\`\`\`${err.message}\`\`\`` },
            },
          ],
        });
      } catch {
        // ignore
      }
      resolve();
    });

    emitter.on("done", async ({ sessionID, exitCode }) => {
      console.log("[opencode done]", { sessionID, exitCode, finished: accumulator.isFinished });
      activeProcesses.delete(emitter);
      // Clear any pending timer and do a final update
      if (updateTimer) clearTimeout(updateTimer);

      // Save session ID for continuation
      if (sessionID) {
        upsertThread(threadTs, { sessionID });
      }

      try {
        const blocks = accumulator.blocks();
        console.log("[final update]", blocks.length, "blocks");
        // If exit was non-zero and we have no content, show error
        if (exitCode !== 0 && blocks.length <= 1) {
          blocks.unshift({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:warning: OpenCode exited with code ${exitCode}`,
            },
          });
        }
        await client.chat.update({
          channel,
          ts: messageTs,
          text: "OpenCode response",
          blocks,
        });
        console.log("[final update] success");
      } catch (err) {
        console.error("[final update error]", err?.data?.error ?? err.message);
      }

      resolve();
    });
  });
}

// ── Directive parsing ───────────────────────────────────────────────────
// Users can prefix their message with  dir:/some/path  to set the working dir

function parseDirectives(text) {
  let directory = null;
  let message = text;

  // Match dir:/path/to/thing at start of message
  const dirMatch = message.match(/^dir:(\S+)\s*/);
  if (dirMatch) {
    const raw = dirMatch[1];
    // Resolve and validate — must be an absolute path, no traversal tricks
    const resolved = path.resolve(raw);
    directory = resolved;
    message = message.slice(dirMatch[0].length).trim();
  }

  return { message, directory };
}

// ── Startup ─────────────────────────────────────────────────────────────

function requiredEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

(async () => {
  await bolt.start();
  console.log("⚡ OpenCode Slack bot is running (Socket Mode)");
  console.log(`   Allowed user: ${ALLOWED_USER_ID}`);
  console.log(`   Default dir:  ${DEFAULT_DIR}`);
})();

// ── Graceful shutdown ───────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down...`);
  for (const emitter of activeProcesses) {
    try {
      emitter.abort();
    } catch {
      // ignore
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
