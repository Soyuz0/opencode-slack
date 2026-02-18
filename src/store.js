/**
 * In-memory store mapping Slack threads to OpenCode sessions.
 *
 * Each thread tracks:
 *  - sessionID:  the OpenCode session to --session continue with
 *  - directory:  the working directory for this conversation
 *  - busy:       whether a request is currently in-flight
 *  - queue:      messages that arrived while busy (played in order)
 */

const threads = new Map();

export function getThread(threadTs) {
  return threads.get(threadTs) ?? null;
}

export function upsertThread(threadTs, patch) {
  const existing = threads.get(threadTs) ?? {
    sessionID: null,
    directory: null,
    busy: false,
    queue: [],
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
