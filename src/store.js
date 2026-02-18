/**
 * In-memory store mapping Slack threads to OpenCode sessions.
 *
 * Each thread tracks:
 *  - sessionID:      the OpenCode session to --session continue with
 *  - directory:      the working directory for this conversation
 *  - model:          model override for this thread (null = default)
 *  - agent:          agent override for this thread (null = default)
 *  - busy:           whether a request is currently in-flight
 *  - queue:          messages that arrived while busy (played in order)
 *  - pendingMessage: the user's first message, held while they pick a folder
 *  - pendingCommand: slash command pending folder selection (e.g. "init")
 *  - pickerTs:       ts of the folder-picker message (for updating it)
 *  - browsePath:     current path in the folder browser
 */

const threads = new Map();

export function getThread(threadTs) {
  return threads.get(threadTs) ?? null;
}

export function upsertThread(threadTs, patch) {
  const existing = threads.get(threadTs) ?? {
    sessionID: null,
    directory: null,
    model: null,
    agent: null,
    busy: false,
    queue: [],
    pendingMessage: null,
    pendingCommand: null,
    pickerTs: null,
    browsePath: null,
  };
  const updated = { ...existing, ...patch };
  threads.set(threadTs, updated);
  return updated;
}

export function deleteThread(threadTs) {
  threads.delete(threadTs);
}

export function allThreads() {
  return [...threads.entries()];
}
