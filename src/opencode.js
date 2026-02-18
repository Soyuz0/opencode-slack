/**
 * Spawns `opencode run --format json` and streams parsed JSON events
 * back through an async generator.
 *
 * Supports:
 *  - New sessions (no sessionID)
 *  - Continuing sessions (with --session <id>)
 *  - Configurable working directory, model, agent, command, files
 */

import { spawn, execFile } from "node:child_process";
import { EventEmitter } from "node:events";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const OPENCODE_BIN = process.env.OPENCODE_BIN || `${HOME}/.opencode/bin/opencode`;
const DEFAULT_MODEL = "anthropic/claude-opus-4-6";
const RAW_LIST_CACHE_TTL_MS = Number(process.env.OPENCODE_LIST_CACHE_TTL_MS || "300000");
const LIST_CACHE_TTL_MS = Number.isFinite(RAW_LIST_CACHE_TTL_MS) && RAW_LIST_CACHE_TTL_MS > 0
  ? RAW_LIST_CACHE_TTL_MS
  : 300000;

/**
 * @typedef {Object} RunOptions
 * @property {string}   message     - The user message
 * @property {string}   [sessionID] - Continue an existing session
 * @property {string}   [directory] - Working directory for opencode
 * @property {string}   [model]     - Model override (provider/model)
 * @property {string}   [agent]     - Agent to use (e.g. build, plan, forge)
 * @property {string}   [command]   - Slash command to run (e.g. init)
 * @property {string[]} [files]     - Files to attach
 */

/**
 * Runs opencode and returns an EventEmitter that emits parsed JSON events.
 *
 * Events emitted:
 *   "event"  → { type, timestamp, sessionID, part }
 *   "error"  → Error
 *   "done"   → { sessionID, exitCode }
 *
 * @param {RunOptions} opts
 * @returns {EventEmitter}
 */
export function runOpencode(opts) {
  const emitter = new EventEmitter();

  const args = ["run", "--format", "json", "--thinking"];

  if (opts.sessionID) {
    args.push("--session", opts.sessionID);
  }

  if (opts.model) {
    args.push("-m", opts.model);
  } else {
    args.push("-m", DEFAULT_MODEL);
  }

  if (opts.agent) {
    args.push("--agent", opts.agent);
  }

  if (opts.command) {
    args.push("--command", opts.command);
  }

  if (opts.directory) {
    args.push("--dir", opts.directory);
  }

  if (opts.files?.length) {
    for (const f of opts.files) {
      args.push("-f", f);
    }
  }

  // The message goes last as positional args
  args.push(opts.message);

  console.log("[opencode spawn]", OPENCODE_BIN, args.join(" "));

  const child = spawn(OPENCODE_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Expose for external abort
  emitter.child = child;
  emitter.abort = () => {
    child.kill("SIGTERM");
  };

  let buffer = "";
  let lastSessionID = opts.sessionID || null;

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    // Each JSON event is a single line
    const lines = buffer.split("\n");
    // Keep the last (possibly incomplete) chunk
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event.sessionID) {
          lastSessionID = event.sessionID;
        }
        emitter.emit("event", event);
      } catch {
        // Not valid JSON — might be opencode startup noise, ignore
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      emitter.emit("stderr", text);
    }
  });

  child.on("error", (err) => {
    emitter.emit("error", err);
  });

  child.on("close", (exitCode) => {
    // Flush remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer.trim());
        if (event.sessionID) lastSessionID = event.sessionID;
        emitter.emit("event", event);
      } catch {
        // ignore
      }
    }
    emitter.emit("done", { sessionID: lastSessionID, exitCode });
  });

  return emitter;
}

/**
 * Lists available models by running `opencode models`.
 * Returns an array of model ID strings.
 * Results are cached with a TTL.
 *
 * @returns {Promise<string[]>}
 */
let _modelsCache = null;
let _modelsCacheExpiresAt = 0;
export async function listModels() {
  if (_modelsCache && Date.now() < _modelsCacheExpiresAt) {
    return _modelsCache;
  }

  return new Promise((resolve) => {
    execFile(OPENCODE_BIN, ["models"], { timeout: 15000 }, (err, stdout) => {
      if (err) {
        console.error("[listModels error]", err.message);
        resolve([]);
        return;
      }
      const models = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      _modelsCache = models;
      _modelsCacheExpiresAt = Date.now() + LIST_CACHE_TTL_MS;
      resolve(models);
    });
  });
}

/**
 * Lists available agents by running `opencode agent list`.
 * Returns an array of { name, type } objects.
 * Results are cached with a TTL.
 *
 * @returns {Promise<Array<{name: string, type: string}>>}
 */
let _agentsCache = null;
let _agentsCacheExpiresAt = 0;
export async function listAgents() {
  if (_agentsCache && Date.now() < _agentsCacheExpiresAt) {
    return _agentsCache;
  }

  return new Promise((resolve) => {
    execFile(OPENCODE_BIN, ["agent", "list"], { timeout: 15000 }, (err, stdout) => {
      if (err) {
        console.error("[listAgents error]", err.message);
        resolve([]);
        return;
      }
      // Output format: "agentname (type)\n  [permissions json...]"
      // We only care about the header lines
      const agents = [];
      for (const line of stdout.split("\n")) {
        const match = line.match(/^(\w+)\s+\((\w+)\)/);
        if (match) {
          agents.push({ name: match[1], type: match[2] });
        }
      }
      _agentsCache = agents;
      _agentsCacheExpiresAt = Date.now() + LIST_CACHE_TTL_MS;
      resolve(agents);
    });
  });
}
