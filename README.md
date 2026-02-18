# OpenCode Slack Bridge

Run OpenCode from Slack threads.

This bot lets you DM or mention a Slack app and have it run `opencode` commands behind the scenes, then stream back:

- assistant text
- tool calls
- file edits / writes
- token usage and cost

Each Slack thread maps to one OpenCode session, so replies continue context automatically.

## What this project includes

- `src/app.js` - Slack Bolt app (Socket Mode), event handlers, queueing
- `src/opencode.js` - spawns `opencode run --format json` and streams JSON events
- `src/formatter.js` - converts OpenCode events into Slack Block Kit output
- `src/store.js` - in-memory thread -> session mapping
- `slack-manifest.json` - Slack app manifest you can import

## Prerequisites

- Node.js 20+
- `opencode` installed locally
- A Slack workspace where you can create apps

## 1) Install dependencies

```bash
npm install
```

## 2) Create the Slack app

Recommended: use the included manifest.

1. Go to Slack API app creation
2. Choose **From a manifest**
3. Paste `slack-manifest.json`
4. Create app

Then collect:

- Bot token (`xoxb-...`)
- App-level token (`xapp-...`) with `connections:write`
- Signing secret

Also copy your Slack user ID (`U...`) for allow-listing.

## 3) Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```dotenv
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
ALLOWED_USER_ID=U...
OPENCODE_DEFAULT_DIR=/absolute/path/to/project
# Optional; defaults to ~/.opencode/bin/opencode
# OPENCODE_BIN=opencode
```

## 4) Run the bot

```bash
npm start
```

You should see startup logs indicating Socket Mode is connected.

## How to use

### Start a conversation

- DM the bot: `hello`
- or mention in channel: `@OpenCode fix the failing tests`

### Continue conversation

- Reply in the same thread to continue the same OpenCode session

### Set working directory per conversation

Use the `dir:` prefix at the start of a message:

```text
dir:/Users/you/my-repo explain this codebase
```

That thread will keep using that directory unless changed again.

## Behavior notes

- Default model: `anthropic/claude-opus-4-6`
- Single-user allow-list via `ALLOWED_USER_ID`
- Messages are queued per thread while one run is in progress
- Session state is in-memory (lost on restart)

## Troubleshooting

### Bot shows "Thinking..." but never replies

- Ensure `opencode` works directly in terminal:

```bash
opencode run --format json "hello"
```

- If needed, set absolute path in `.env`:

```dotenv
OPENCODE_BIN=/Users/<you>/.opencode/bin/opencode
```

### Bot does not react in Slack

- Confirm app is installed to workspace
- Confirm Socket Mode is enabled
- Confirm required events are enabled (`app_mention`, `message.im`)
- Confirm tokens/secrets in `.env` are correct
- Confirm message sender matches `ALLOWED_USER_ID`

### No responses in channels, but DM works

- Mention the bot with `@OpenCode ...`
- For thread replies, bot only responds in threads it already started/tracks

## Security considerations

- This bot executes OpenCode instructions with local machine access
- Restrict with `ALLOWED_USER_ID`
- Run under a least-privileged local account
- Be careful when changing `dir:` to sensitive directories
