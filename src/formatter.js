/**
 * Converts OpenCode JSON streaming events into Slack Block Kit blocks.
 *
 * This module maintains a mutable "accumulator" for a single opencode run.
 * As events arrive, call accumulator.push(event) — then read accumulator.blocks()
 * to get the current Slack blocks for a chat.update call.
 *
 * Slack limits: 50 blocks per message, 3000 chars per text block.
 * We handle truncation gracefully.
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
            // Flush any prior text before new step
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
          // Flush text before tool block
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

        // Thinking / reasoning blocks (some models emit these)
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

      // Render all accumulated parts
      for (const p of parts) {
        if (blocks.length >= MAX_BLOCKS) break;
        switch (p.type) {
          case "text":
            blocks.push(markdownSection(truncate(p.data)));
            break;
          case "tool":
            blocks.push(...toolBlocks(p.data));
            break;
          case "thinking":
            blocks.push(
              markdownSection(`>_*Thinking:*_\n>${truncate(p.data, 1500).split("\n").join("\n>")}`)
            );
            break;
        }
      }

      // Render current streaming text (not yet flushed)
      if (currentText && blocks.length < MAX_BLOCKS) {
        blocks.push(markdownSection(truncate(currentText)));
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

      // Slack requires at least one block
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

// ── Helpers ────────────────────────────────────────────────────────────

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

  // Show condensed input
  const inputStr = formatToolInput(tool, input);
  if (inputStr) {
    blocks.push(markdownSection(`\`\`\`\n${truncate(inputStr, 1500)}\n\`\`\``));
  }

  // Show output if completed
  if (status === "completed" && output) {
    const outStr = typeof output === "string" ? output : JSON.stringify(output, null, 2);
    if (outStr.length > 300) {
      // Collapsed-style: just show first/last few lines
      const lines = outStr.split("\n");
      const preview =
        lines.length > 10
          ? [...lines.slice(0, 5), `... (${lines.length - 10} more lines)`, ...lines.slice(-5)].join("\n")
          : outStr;
      blocks.push(markdownSection(`\`\`\`\n${truncate(preview, 1500)}\n\`\`\``));
    } else {
      blocks.push(markdownSection(`\`\`\`\n${outStr}\n\`\`\``));
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
      return `edit → ${input.filePath ?? "?"}\n- ${truncate(input.oldString ?? "", 200)}\n+ ${truncate(input.newString ?? "", 200)}`;
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

function truncate(str, max = MAX_TEXT_LEN) {
  if (!str) return "";
  if (str.length <= max) return str;
  return str.slice(0, max) + "\n... (truncated)";
}

function fmtNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
