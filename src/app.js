/**
 * OpenCode ↔ Slack Bridge
 *
 * A Slack bot that lets you interact with OpenCode from Slack threads.
 * - Mention @opencode or DM the bot to start a conversation
 * - Reply in the thread to continue the same session
 * - Set working directory per-conversation with:  dir:/path/to/project
 * - Interactive folder picker for new conversations
 * - Commands: !init, !model, !agents
 * - Every tool call, file change, and response streams in real-time
 */

import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import pkg from "@slack/bolt";
const { App } = pkg;
import { runOpencode, listModels, listAgents } from "./opencode.js";
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

// Popular model shortlist for the picker (full list available via search)
const MODEL_SHORTLIST = [
  "anthropic/claude-opus-4-6",
  "anthropic/claude-opus-4-5",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-haiku-4-5",
  "openai/gpt-5.2",
  "openai/codex-5.3",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
];

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
  const { message, directory, slashCommand } = parseDirectives(text);

  // Handle slash commands
  if (slashCommand) {
    await handleSlashCommand({ command: slashCommand.command, args: slashCommand.args, threadTs, channel, client });
    return;
  }

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
  if ((thread.pendingMessage || thread.pendingCommand) && !thread.directory) {
    const queue = thread.queue || [];
    upsertThread(threadTs, { queue: [...queue, message] });
    return;
  }

  await runWithQueue({ threadTs, channel, client, message });
}

// ── Run with busy guard and queue drain ─────────────────────────────────

async function runWithQueue({ threadTs, channel, client, message, command }) {
  const thread = getThread(threadTs);

  // Queue if busy
  if (thread?.busy) {
    const queue = thread.queue || [];
    upsertThread(threadTs, { queue: [...queue, message] });
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `_Queued — waiting for current request to finish..._`,
    });
    return;
  }

  upsertThread(threadTs, { busy: true });

  await processMessage({ message, threadTs, channel, client, command });

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

// ── Slash commands ──────────────────────────────────────────────────────

async function handleSlashCommand({ command, args, threadTs, channel, client }) {
  console.log("[slash command]", command, args, "thread:", threadTs);

  switch (command) {
    case "init":
      await handleInit({ threadTs, channel, client });
      break;
    case "models":
      await handleModelCommand({ args, threadTs, channel, client });
      break;
    case "agents":
      await handleAgentsCommand({ args, threadTs, channel, client });
      break;
    default:
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Unknown command: \`!${command}\`\nAvailable: \`!init\`, \`!models\`, \`!agents\``,
      });
  }
}

// ── /init — generate AGENTS.md ──────────────────────────────────────────

async function handleInit({ threadTs, channel, client }) {
  let thread = getThread(threadTs);

  // Need a directory first
  if (!thread?.directory) {
    if (!thread) {
      // Store a structured pending command instead of raw text
      // so folderSelected can dispatch it directly
      upsertThread(threadTs, { pendingMessage: null, pendingCommand: "init" });
      await showFolderPicker({ threadTs, channel, client, browsePath: null });
      return;
    }
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `_No directory set. Use \`dir:/path/to/project\` first, or start a new conversation._`,
    });
    return;
  }

  // Run /init via --command init, with busy guard
  await runWithQueue({
    threadTs,
    channel,
    client,
    message: "initialize this project",
    command: "init",
  });
}

// ── /model — show model picker or set model directly ────────────────────

async function handleModelCommand({ args, threadTs, channel, client }) {
  const thread = getThread(threadTs);
  const currentModel = thread?.model || "anthropic/claude-opus-4-6 (default)";

  // If args provided, set model directly
  if (args) {
    const models = await listModels();
    if (models.length === 0) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `:x: Could not load models list. Make sure opencode is configured and accessible.`,
      });
      return;
    }
    // Exact match or partial match
    const exact = models.find((m) => m === args);
    const partial = !exact ? models.filter((m) => m.includes(args)) : [];

    if (exact) {
      upsertThread(threadTs, { model: exact });
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `:white_check_mark: Model set to \`${exact}\``,
      });
      if (!getThread(threadTs)?.directory) {
        await showFolderPicker({ threadTs, channel, client, browsePath: null });
      }
      return;
    }

    if (partial.length === 1) {
      upsertThread(threadTs, { model: partial[0] });
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `:white_check_mark: Model set to \`${partial[0]}\``,
      });
      if (!getThread(threadTs)?.directory) {
        await showFolderPicker({ threadTs, channel, client, browsePath: null });
      }
      return;
    }

    if (partial.length > 1 && partial.length <= 20) {
      // Show matches as buttons
      const chunks = chunkArray(partial, 5);
      const blocks = [
        markdownSection(`:mag: Multiple matches for \`${args}\`:`),
      ];
      for (const [chunkIndex, chunk] of chunks.entries()) {
        blocks.push({
          type: "actions",
          elements: chunk.map((m, modelIndex) => ({
            type: "button",
            text: { type: "plain_text", text: truncLabel(m, 60), emoji: true },
            value: JSON.stringify({ action: "set_model", model: m, threadTs }),
            action_id: `model_pick_${chunkIndex}_${modelIndex}`,
          })),
        });
      }
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: "Pick a model", blocks });
      return;
    }

    if (partial.length > 20) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `:mag: ${partial.length} matches for \`${args}\` — be more specific.\nExamples: \`!models claude-opus-4-6\`, \`!models gemini-2.5-pro\``,
      });
      return;
    }

    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `:x: No model found matching \`${args}\``,
    });
    return;
  }

  // No args — show the shortlist picker
  const blocks = [
    markdownSection(`:brain: *Current model:* \`${currentModel}\`\n\nPick a model or type \`!models <search>\` to search:`),
  ];

  const chunks = chunkArray(MODEL_SHORTLIST, 3);
  for (const [chunkIndex, chunk] of chunks.entries()) {
    blocks.push({
      type: "actions",
      elements: chunk.map((m, modelIndex) => ({
        type: "button",
        text: { type: "plain_text", text: truncLabel(m, 60), emoji: true },
        value: JSON.stringify({ action: "set_model", model: m, threadTs }),
        action_id: `model_pick_short_${chunkIndex}_${modelIndex}`,
      })),
    });
  }

  await client.chat.postMessage({ channel, thread_ts: threadTs, text: "Choose a model", blocks });
}

// ── /agents — show agent picker or set agent directly ───────────────────

async function handleAgentsCommand({ args, threadTs, channel, client }) {
  const thread = getThread(threadTs);
  const currentAgent = thread?.agent || "build (default)";

  // If args provided, set agent directly
  if (args) {
    const agents = await listAgents();
    const match = agents.find((a) => a.name === args);

    if (match) {
      upsertThread(threadTs, { agent: match.name });
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `:white_check_mark: Agent set to \`${match.name}\` (${match.type})`,
      });
      if (!getThread(threadTs)?.directory) {
        await showFolderPicker({ threadTs, channel, client, browsePath: null });
      }
      return;
    }

    // Partial match
    const partial = agents.filter((a) => a.name.includes(args));
    if (partial.length === 1) {
      upsertThread(threadTs, { agent: partial[0].name });
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `:white_check_mark: Agent set to \`${partial[0].name}\` (${partial[0].type})`,
      });
      if (!getThread(threadTs)?.directory) {
        await showFolderPicker({ threadTs, channel, client, browsePath: null });
      }
      return;
    }

    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `:x: No agent found matching \`${args}\``,
    });
    return;
  }

  // No args — show all agents as buttons
  const agents = await listAgents();

  if (agents.length === 0) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `:x: Could not load agents list. Make sure opencode is configured.`,
    });
    return;
  }

  const blocks = [
    markdownSection(`:robot_face: *Current agent:* \`${currentAgent}\`\n\nPick an agent:`),
  ];

  // Group by type
  const primary = agents.filter((a) => a.type === "primary");
  const subagent = agents.filter((a) => a.type === "subagent");

  if (primary.length > 0) {
    blocks.push(markdownSection("*Primary agents:*"));
    const chunks = chunkArray(primary, 5);
    for (const chunk of chunks) {
      blocks.push({
        type: "actions",
        elements: chunk.map((a) => ({
          type: "button",
          text: { type: "plain_text", text: a.name, emoji: true },
          value: JSON.stringify({ action: "set_agent", agent: a.name, threadTs }),
          action_id: `agent_pick_${a.name}`,
        })),
      });
    }
  }

  if (subagent.length > 0) {
    blocks.push(markdownSection("*Subagents:*"));
    const chunks = chunkArray(subagent, 5);
    for (const chunk of chunks) {
      blocks.push({
        type: "actions",
        elements: chunk.map((a) => ({
          type: "button",
          text: { type: "plain_text", text: a.name, emoji: true },
          value: JSON.stringify({ action: "set_agent", agent: a.name, threadTs }),
          action_id: `agent_pick_${a.name}`,
        })),
      });
    }
  }

  await client.chat.postMessage({ channel, thread_ts: threadTs, text: "Choose an agent", blocks });
}

// ── Folder picker ───────────────────────────────────────────────────────

async function showFolderPicker({ threadTs, channel, client, browsePath }) {
  const blocks = [];

  if (!browsePath) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: ":file_folder: *Choose a project folder:*" },
    });

    if (PROJECTS.length > 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "*Bookmarks:*" },
      });

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
    blocks.push(...buildBrowseBlocks(browsePath, threadTs));
  }

  const thread = getThread(threadTs);

  if (thread?.pickerTs) {
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

// Folder picker actions
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

// Model picker actions
bolt.action(/^model_pick_/, async ({ action, ack, body, client }) => {
  await ack();
  if (!isAllowed(body.user?.id)) return;

  let payload;
  try {
    payload = JSON.parse(action.value);
  } catch {
    console.error("[action] bad payload", action.value);
    return;
  }

  const { model, threadTs } = payload;
  const channel = body.channel?.id;

  console.log("[model action]", model, "thread:", threadTs);

  upsertThread(threadTs, { model });

  try {
    await client.chat.update({
      channel,
      ts: body.message.ts,
      text: `Model: ${model}`,
      blocks: [markdownSection(`:white_check_mark: *Model set to:* \`${model}\``)],
    });
  } catch (err) {
    console.error("[model update error]", err?.data?.error ?? err.message);
  }

  // Show folder picker if no directory set yet
  const thread = getThread(threadTs);
  if (!thread?.directory) {
    await showFolderPicker({ threadTs, channel, client, browsePath: null });
  }
});

// Agent picker actions
bolt.action(/^agent_pick_/, async ({ action, ack, body, client }) => {
  await ack();
  if (!isAllowed(body.user?.id)) return;

  let payload;
  try {
    payload = JSON.parse(action.value);
  } catch {
    console.error("[action] bad payload", action.value);
    return;
  }

  const { agent, threadTs } = payload;
  const channel = body.channel?.id;

  console.log("[agent action]", agent, "thread:", threadTs);

  upsertThread(threadTs, { agent });

  try {
    await client.chat.update({
      channel,
      ts: body.message.ts,
      text: `Agent: ${agent}`,
      blocks: [markdownSection(`:white_check_mark: *Agent set to:* \`${agent}\``)],
    });
  } catch (err) {
    console.error("[agent update error]", err?.data?.error ?? err.message);
  }

  // Show folder picker if no directory set yet
  const thread = getThread(threadTs);
  if (!thread?.directory) {
    await showFolderPicker({ threadTs, channel, client, browsePath: null });
  }
});

async function folderSelected({ dir, threadTs, channel, client }) {
  const thread = getThread(threadTs);
  if (!thread) return;

  const pendingMessage = thread.pendingMessage;
  const pendingCommand = thread.pendingCommand;

  if (thread.pickerTs) {
    try {
      await client.chat.update({
        channel,
        ts: thread.pickerTs,
        text: `Folder: ${dir}`,
        blocks: [markdownSection(`:white_check_mark: *Folder:* \`${dir}\``)],
      });
    } catch (err) {
      console.error("[picker replace error]", err?.data?.error ?? err.message);
    }
  }

  upsertThread(threadTs, {
    directory: dir,
    pendingMessage: null,
    pendingCommand: null,
    pickerTs: null,
    browsePath: null,
  });

  // Dispatch pending command or message
  if (pendingCommand) {
    await handleSlashCommand({ command: pendingCommand, args: null, threadTs, channel, client });
  } else if (pendingMessage) {
    await handleMessage({ text: pendingMessage, threadTs, channel, client });
  }
}

// ── Process a single opencode run ───────────────────────────────────────

async function processMessage({ message, threadTs, channel, client, command }) {
  const thread = getThread(threadTs);
  const accumulator = createAccumulator();

  const initial = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "Processing...",
    blocks: accumulator.blocks(),
  });
  const messageTs = initial.ts;

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

  const emitter = runOpencode({
    message,
    sessionID: thread.sessionID,
    directory: thread.directory,
    model: thread.model || undefined,
    agent: thread.agent || undefined,
    command: command || undefined,
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
          blocks: [markdownSection(`:x: *OpenCode error:*\n\`\`\`${err.message}\`\`\``)],
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
          blocks.unshift(markdownSection(`:warning: OpenCode exited with code ${exitCode}`));
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
  let slashCommand = null;

  // Check for commands: !init, !model, !agents
  const cmdMatch = message.match(/^!(init|models|agents)(?:\s+(.*))?$/);
  if (cmdMatch) {
    slashCommand = {
      command: cmdMatch[1],
      args: cmdMatch[2]?.trim() || null,
    };
    return { message: null, directory: null, slashCommand };
  }

  // Match dir:/path/to/thing at start of message
  const dirMatch = message.match(/^dir:(\S+)\s*/);
  if (dirMatch) {
    const raw = dirMatch[1];
    const resolved = path.resolve(raw);
    directory = resolved;
    message = message.slice(dirMatch[0].length).trim();
  }

  return { message, directory, slashCommand: null };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function markdownSection(text) {
  return {
    type: "section",
    text: { type: "mrkdwn", text: text || " " },
  };
}

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

  // Pre-warm caches
  listModels()
    .then((m) => console.log(`   Models:       ${m.length} available`))
    .catch((err) => console.error("[startup model prewarm error]", err?.message ?? err));
  listAgents()
    .then((a) => console.log(`   Agents:       ${a.map((x) => x.name).join(", ")}`))
    .catch((err) => console.error("[startup agent prewarm error]", err?.message ?? err));
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
