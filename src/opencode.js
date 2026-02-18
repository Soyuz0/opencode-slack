/**
 * Spawns `opencode run --format json` and streams parsed JSON events
 * back through an async generator.
 *
 * Supports:
 *  - New sessions (no sessionID)
 *  - Continuing sessions (with --session <id>)
 *  - Configurable working directory, model, files
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const OPENCODE_BIN = process.env.OPENCODE_BIN || `${HOME}/.opencode/bin/opencode`;
const DEFAULT_MODEL = "anthropic/claude-opus-4-6";

/**
 * @typedef {Object} RunOptions
 * @property {string}   message     - The user message
 * @property {string}   [sessionID] - Continue an existing session
 * @property {string}   [directory] - Working directory for opencode
 * @property {string}   [model]     - Model override (provider/model)
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
