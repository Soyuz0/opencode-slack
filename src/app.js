/**
 * OpenCode ↔ Slack Bridge
 *
 * A Slack bot that lets you interact with OpenCode from Slack threads.
 * - Mention @opencode or DM the bot to start a conversation
 * - Reply in the thread to continue the same session
 * - Set working directory per-conversation with:  dir:/path/to/project
 * - Interactive folder picker for new conversations
 * - Every tool call, file change, and response streams in real-time
 */

import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
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
const BROWSE_ROOT = process.env.OPENCODE_BROWSE_ROOT || process.env.HOME || "/";

// Bookmarked projects — comma-separated paths
const PROJECTS = (process.env.OPENCODE_PROJECTS || "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

// How often to update the Slack message while streaming (ms)
const UPDATE_INTERVAL = 1500;

// Max folders to show in browser (Slack limits actions per block)
const MAX_BROWSE_FOLDERS = 20;

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

  if (event.subtype) return;
  if (event.bot_id) return;
  if (!event.text) return;
  if (!isAllowed(event.user)) return;

  const isDM = event.channel_type === "im";
  const isThreadReply = event.thread_ts && event.thread_ts !== event.ts;

  if (!isDM && !isThreadReply) return;

  // For thread replies, only respond if we have an active session for this thread
  if (isThreadReply) {
    const thread = getThread(event.thread_ts);
    if (!thread) return;
  }

  const threadTs = event.thread_ts || event.ts;
  const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!text) return;

  console.log("[handling message]", text.slice(0, 80), "thread:", threadTs);
  await handleMessage({ text, threadTs, channel: event.channel, client });
});

// ── Core: send message to OpenCode, stream response back ────────────────

async function handleMessage({ text, threadTs, channel, client }) {
  const { message, directory } = parseDirectives(text);
  if (!message) return;

  let thread = getThread(threadTs);

  if (directory) {
    thread = upsertThread(threadTs, { directory });
  }

  // If this is a brand new thread with no directory set, show the folder picker
  if (!thread && !directory) {
    upsertThread(threadTs, { pendingMessage: message });
    await showFolderPicker({ threadTs, channel, client, browsePath: null });
    return;
  }

  if (!thread) {
    thread = upsertThread(threadTs, { directory: directory || DEFAULT_DIR });
  }

  // If thread exists but still waiting for folder pick
  if (thread.pendingMessage && !thread.directory) {
    thread.queue.push(message);
    upsertThread(threadTs, { queue: thread.queue });
    return;
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

// ── Folder picker ───────────────────────────────────────────────────────

async function showFolderPicker({ threadTs, channel, client, browsePath }) {
  const blocks = [];

  if (!browsePath) {
    // ── Initial picker: bookmarks + browse button ──
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: ":file_folder: *Choose a project folder:*" },
    });

    // Bookmark buttons (if configured)
    if (PROJECTS.length > 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "*Bookmarks:*" },
      });

      // Chunk into rows of 5 (Slack max per actions block)
      const chunks = chunkArray(PROJECTS, 5);
      for (const chunk of chunks) {
        blocks.push({
          type: "actions",
          elements: chunk.map((p) => ({
            type: "button",
            text: { type: "plain_text", text: truncLabel(path.basename(p) || p), emoji: true },
            value: JSON.stringify({ action: "select", dir: p, threadTs }),
            action_id: `folder_select_${p}`,
          })),
        });
      }

      blocks.push({ type: "divider" });
    }

    // Browse button
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: ":open_file_folder: Browse...", emoji: true },
          value: JSON.stringify({ action: "browse", dir: BROWSE_ROOT, threadTs }),
          action_id: "folder_browse",
        },
        {
          type: "button",
          text: { type: "plain_text", text: ":fast_forward: Use default", emoji: true },
          value: JSON.stringify({ action: "select", dir: DEFAULT_DIR, threadTs }),
          action_id: "folder_use_default",
        },
      ],
    });
  } else {
    // ── Browser view: show subdirectories of browsePath ──
    blocks.push(...buildBrowseBlocks(browsePath, threadTs));
  }

  const thread = getThread(threadTs);

  if (thread?.pickerTs) {
    // Update existing picker message
    try {
      await client.chat.update({
        channel,
        ts: thread.pickerTs,
        text: "Choose a folder",
        blocks,
      });
    } catch (err) {
      console.error("[picker update error]", err?.data?.error ?? err.message);
    }
  } else {
    // Post new picker message
    const result = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "Choose a folder",
      blocks,
    });
    upsertThread(threadTs, { pickerTs: result.ts });
  }
}

function buildBrowseBlocks(browsePath, threadTs) {
  const blocks = [];
  const resolved = path.resolve(browsePath);

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `:open_file_folder: *${resolved}*` },
  });

  // Navigation: parent + select
  const parentDir = path.dirname(resolved);
  const navElements = [];

  if (parentDir !== resolved) {
    navElements.push({
      type: "button",
      text: { type: "plain_text", text: ":arrow_up: Parent", emoji: true },
      value: JSON.stringify({ action: "browse", dir: parentDir, threadTs }),
      action_id: "folder_parent",
    });
  }

  navElements.push({
    type: "button",
    text: { type: "plain_text", text: ":white_check_mark: Use this folder", emoji: true },
    style: "primary",
    value: JSON.stringify({ action: "select", dir: resolved, threadTs }),
    action_id: "folder_select_current",
  });

  blocks.push({ type: "actions", elements: navElements });
  blocks.push({ type: "divider" });

  // List subdirectories
  let subdirs = [];
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    subdirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch (err) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:x: Can't read directory: ${err.message}` },
    });
    return blocks;
  }

  if (subdirs.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No subdirectories_" },
    });
    return blocks;
  }

  // Show folders — chunk into rows of 5 buttons
  const shown = subdirs.slice(0, MAX_BROWSE_FOLDERS);
  const chunks = chunkArray(shown, 5);

  for (const chunk of chunks) {
    blocks.push({
      type: "actions",
      elements: chunk.map((name) => ({
        type: "button",
        text: { type: "plain_text", text: truncLabel(name + "/"), emoji: true },
        value: JSON.stringify({ action: "browse", dir: path.join(resolved, name), threadTs }),
        action_id: `folder_cd_${name}`,
      })),
    });
  }

  if (subdirs.length > MAX_BROWSE_FOLDERS) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `_...and ${subdirs.length - MAX_BROWSE_FOLDERS} more folders_` }],
    });
  }

  return blocks;
}

// ── Action handlers (button clicks) ─────────────────────────────────────

// Match all button action_ids that start with "folder_"
bolt.action(/^folder_/, async ({ action, ack, body, client }) => {
  await ack();

  if (!isAllowed(body.user?.id)) return;

  let payload;
  try {
    payload = JSON.parse(action.value);
  } catch {
    console.error("[action] bad payload", action.value);
    return;
  }

  const { action: act, dir, threadTs } = payload;
  const channel = body.channel?.id;

  console.log("[folder action]", act, dir, "thread:", threadTs);

  if (act === "browse") {
    upsertThread(threadTs, { browsePath: dir });
    await showFolderPicker({ threadTs, channel, client, browsePath: dir });
  } else if (act === "select") {
    await folderSelected({ dir, threadTs, channel, client });
  }
});

async function folderSelected({ dir, threadTs, channel, client }) {
  const thread = getThread(threadTs);
  if (!thread) return;

  const pendingMessage = thread.pendingMessage;

  // Update picker message to show selection
  if (thread.pickerTs) {
    try {
      await client.chat.update({
        channel,
        ts: thread.pickerTs,
        text: `Folder: ${dir}`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `:white_check_mark: *Folder:* \`${dir}\`` },
          },
        ],
      });
    } catch (err) {
      console.error("[picker replace error]", err?.data?.error ?? err.message);
    }
  }

  // Set directory, clear pending state
  upsertThread(threadTs, {
    directory: dir,
    pendingMessage: null,
    pickerTs: null,
    browsePath: null,
  });

  // Now run the pending message
  if (pendingMessage) {
    await handleMessage({ text: pendingMessage, threadTs, channel, client });
  }
}

// ── Process a single opencode run ───────────────────────────────────────

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
        if (err?.data?.error === "ratelimited") {
          // Back off
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
      if (updateTimer) clearTimeout(updateTimer);

      if (sessionID) {
        upsertThread(threadTs, { sessionID });
      }

      try {
        const blocks = accumulator.blocks();
        console.log("[final update]", blocks.length, "blocks");
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

function parseDirectives(text) {
  let directory = null;
  let message = text;

  const dirMatch = message.match(/^dir:(\S+)\s*/);
  if (dirMatch) {
    const raw = dirMatch[1];
    const resolved = path.resolve(raw);
    directory = resolved;
    message = message.slice(dirMatch[0].length).trim();
  }

  return { message, directory };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function truncLabel(str, max = 24) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}

function requiredEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

// ── Startup ─────────────────────────────────────────────────────────────

(async () => {
  await bolt.start();
  console.log("⚡ OpenCode Slack bot is running (Socket Mode)");
  console.log(`   Allowed user: ${ALLOWED_USER_ID}`);
  console.log(`   Default dir:  ${DEFAULT_DIR}`);
  console.log(`   Browse root:  ${BROWSE_ROOT}`);
  console.log(`   Bookmarks:    ${PROJECTS.length ? PROJECTS.join(", ") : "(none)"}`);
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
