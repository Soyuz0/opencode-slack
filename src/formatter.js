/**
 * Converts OpenCode JSON streaming events into Slack Block Kit blocks.
 *
 * This module maintains a mutable "accumulator" for a single opencode run.
 * As events arrive, call accumulator.push(event) — then read accumulator.blocks()
 * to get the current Slack blocks for a chat.update call.
 *
 * Slack limits: 50 blocks per message, 3000 chars per text block.
 * Long text is split across multiple blocks instead of being truncated.
 */

const MAX_TEXT_LEN = 2900; // leave margin under 3000
const MAX_BLOCKS = 49; // leave room for overflow notice

/**
 * Creates a new message accumulator for one opencode invocation.
 */
export function createAccumulator() {
  /** @type {Array<{type: string, data: any}>} */
  const parts = [];
  let currentText = "";
  let finished = false;
  let tokenInfo = null;
  let stepCount = 0;

  return {
    /**
     * Feed an opencode JSON event into the accumulator.
     * @param {{type: string, part?: object}} event
     */
    push(event) {
      const { type, part } = event;

      switch (type) {
        case "step_start": {
          stepCount++;
          if (stepCount > 1) {
            if (currentText) {
              parts.push({ type: "text", data: currentText });
              currentText = "";
            }
          }
          break;
        }

        case "text": {
          currentText += part?.text ?? "";
          break;
        }

        case "tool_use": {
          if (currentText) {
            parts.push({ type: "text", data: currentText });
            currentText = "";
          }
          parts.push({ type: "tool", data: formatTool(part) });
          break;
        }

        case "step_finish": {
          if (part?.tokens) {
            tokenInfo = {
              total: part.tokens.total,
              input: part.tokens.input,
              output: part.tokens.output,
              reasoning: part.tokens.reasoning,
              cacheRead: part.tokens.cache?.read ?? 0,
              cacheWrite: part.tokens.cache?.write ?? 0,
              cost: part.cost ?? 0,
            };
          }
          if (part?.reason === "stop") {
            finished = true;
          }
          break;
        }

        case "thinking": {
          if (currentText) {
            parts.push({ type: "text", data: currentText });
            currentText = "";
          }
          parts.push({ type: "thinking", data: part?.thinking ?? part?.text ?? "" });
          break;
        }
      }
    },

    /**
     * Returns Slack Block Kit blocks representing the current state.
     * @returns {object[]}
     */
    blocks() {
      const blocks = [];

      for (const p of parts) {
        if (blocks.length >= MAX_BLOCKS) break;
        switch (p.type) {
          case "text":
            blocks.push(...splitTextBlocks(p.data));
            break;
          case "tool":
            blocks.push(...toolBlocks(p.data));
            break;
          case "thinking":
            blocks.push(...splitThinkingBlocks(p.data));
            break;
        }
      }

      // Render current streaming text (not yet flushed)
      if (currentText && blocks.length < MAX_BLOCKS) {
        blocks.push(...splitTextBlocks(currentText));
      }

      // Status indicator
      if (blocks.length < MAX_BLOCKS) {
        if (!finished) {
          blocks.push(contextBlock("Thinking..."));
        } else if (tokenInfo) {
          const cost =
            tokenInfo.cost > 0 ? `  |  $${tokenInfo.cost.toFixed(4)}` : "";
          const cached =
            tokenInfo.cacheRead > 0
              ? `  |  cache: ${fmtNum(tokenInfo.cacheRead)} read`
              : "";
          blocks.push(
            contextBlock(
              `tokens: ${fmtNum(tokenInfo.input)} in / ${fmtNum(tokenInfo.output)} out${cached}${cost}`
            )
          );
        }
      }

      // Overflow notice
      if (blocks.length >= MAX_BLOCKS) {
        blocks.splice(MAX_BLOCKS);
        blocks.push(contextBlock("(output truncated — too many blocks for Slack)"));
      }

      if (blocks.length === 0) {
        blocks.push(contextBlock("Processing..."));
      }

      return blocks;
    },

    get isFinished() {
      return finished;
    },
  };
}

// ── Text splitting ────────────────────────────────────────────────────

/**
 * Splits long text into multiple Slack section blocks,
 * breaking at newlines to keep content readable.
 */
function splitTextBlocks(text) {
  if (!text) return [];
  const chunks = splitAtBoundary(text, MAX_TEXT_LEN);
  return chunks.map((chunk) => markdownSection(chunk));
}

/**
 * Splits long thinking text into multiple quoted blocks.
 */
function splitThinkingBlocks(text) {
  if (!text) return [];
  const chunks = splitAtBoundary(text, 1400); // smaller because of > prefix overhead
  return chunks.map((chunk) =>
    markdownSection(`>_*Thinking:*_\n>${chunk.split("\n").join("\n>")}`)
  );
}

/**
 * Splits a string into chunks of at most `max` characters,
 * preferring to break at newline boundaries.
 */
function splitAtBoundary(str, max) {
  if (str.length <= max) return [str];

  const chunks = [];
  let remaining = str;

  while (remaining.length > 0) {
    if (remaining.length <= max) {
      chunks.push(remaining);
      break;
    }

    // Find the last newline within the limit
    let splitAt = remaining.lastIndexOf("\n", max);

    // If no newline found, try splitting at a space
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(" ", max);
    }

    // If still no good split point, hard-split at max
    if (splitAt <= 0) {
      splitAt = max;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, ""); // trim leading newline
  }

  return chunks;
}

// ── Tool formatting ───────────────────────────────────────────────────

function formatTool(part) {
  const tool = part?.tool ?? "unknown";
  const state = part?.state ?? {};
  const title = state.title || part?.callID || "";
  const status = state.status ?? "running";
  const input = state.input ?? {};
  const output = state.output ?? "";

  return { tool, title, status, input, output };
}

function toolBlocks({ tool, title, status, input, output }) {
  const blocks = [];
  const icon = status === "completed" ? ":white_check_mark:" : ":hourglass_flowing_sand:";
  const header = `${icon}  *${tool}*${title ? `  \`${title}\`` : ""}`;

  blocks.push(markdownSection(header));

  // Show condensed input — split if long
  const inputStr = formatToolInput(tool, input);
  if (inputStr) {
    const inputChunks = splitAtBoundary(inputStr, 1400);
    for (const chunk of inputChunks) {
      blocks.push(markdownSection(`\`\`\`\n${chunk}\n\`\`\``));
    }
  }

  // Show output if completed — split if long
  if (status === "completed" && output) {
    const outStr = typeof output === "string" ? output : JSON.stringify(output, null, 2);
    const outputChunks = splitAtBoundary(outStr, 1400);
    for (const chunk of outputChunks) {
      blocks.push(markdownSection(`\`\`\`\n${chunk}\n\`\`\``));
    }
  }

  blocks.push({ type: "divider" });
  return blocks;
}

function formatToolInput(tool, input) {
  switch (tool) {
    case "write":
      return `write → ${input.filePath ?? "?"}\n${input.content ?? ""}`;
    case "edit":
      return `edit → ${input.filePath ?? "?"}\n- ${input.oldString ?? ""}\n+ ${input.newString ?? ""}`;
    case "read":
      return `read → ${input.filePath ?? "?"}`;
    case "bash":
      return `$ ${input.command ?? "?"}`;
    case "glob":
      return `glob → ${input.pattern ?? "?"}`;
    case "grep":
      return `grep → ${input.pattern ?? "?"} ${input.include ? `(${input.include})` : ""}`;
    case "todowrite":
      return `update todos`;
    default:
      return JSON.stringify(input, null, 2);
  }
}

// ── Block helpers ─────────────────────────────────────────────────────

function markdownSection(text) {
  return {
    type: "section",
    text: { type: "mrkdwn", text: text || " " },
  };
}

function contextBlock(text) {
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text }],
  };
}

function fmtNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
