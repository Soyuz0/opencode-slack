# OpenCode Slack Bridge

Run OpenCode from Slack threads.

This bot lets you DM or mention a Slack app and have it run `opencode` commands behind the scenes, then stream back:

- assistant text
- tool calls
- file edits / writes
- token usage and cost

Each Slack thread maps to one OpenCode session, so replies continue context automatically.

## What this project includes

- `src/app.js` - Slack Bolt app (Socket Mode), event handlers, folder picker, queueing
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

## 2) Create the Slack app (and get all keys)

Recommended: use the included manifest.

1. Go to `https://api.slack.com/apps`
2. Click **Create New App**
3. Choose **From a manifest**
4. Select your workspace
5. Paste `slack-manifest.json`
6. Create the app

After creation, get each value for `.env`:

- `SLACK_SIGNING_SECRET`
  - Slack app page -> **Basic Information** -> **App Credentials** -> **Signing Secret**
- `SLACK_APP_TOKEN` (`xapp-...`)
  - **Basic Information** -> **App-Level Tokens** -> **Generate Token and Scopes**
  - Name it anything (example: `socket-mode`)
  - Add scope: `connections:write`
  - Copy generated token (`xapp-...`)
- `SLACK_BOT_TOKEN` (`xoxb-...`)
  - **OAuth & Permissions** -> **Install to Workspace**
  - Authorize app
  - Copy **Bot User OAuth Token** (`xoxb-...`)
- `ALLOWED_USER_ID` (`U...`)
  - In Slack desktop/web: click your profile -> more options -> **Copy member ID**

Important settings to verify in Slack app config:

- **Socket Mode**: ON
- **Interactivity & Shortcuts**: ON (required for folder picker buttons)
- **Event Subscriptions** bot events include: `app_mention`, `message.im`

If you change manifest/settings after install, reinstall the app to workspace.

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
OPENCODE_DEFAULT_DIR=/absolute/path/to/default/project

# Bookmarked folders (comma-separated) — shown as quick-pick buttons
OPENCODE_PROJECTS=/path/to/project-a,/path/to/project-b

# Root for the folder browser (defaults to $HOME)
OPENCODE_BROWSE_ROOT=/Users/you

# Optional; defaults to ~/.opencode/bin/opencode
# OPENCODE_BIN=/path/to/opencode
```

Quick check:

- `SLACK_BOT_TOKEN` starts with `xoxb-`
- `SLACK_APP_TOKEN` starts with `xapp-`
- `ALLOWED_USER_ID` starts with `U`
- `OPENCODE_DEFAULT_DIR` is an absolute path that exists
- `OPENCODE_PROJECTS` paths are absolute and comma-separated (no quotes needed)

## 4) Run the bot

```bash
npm start
```

You should see startup logs indicating Socket Mode is connected.

## How to use

### Start a conversation

DM the bot or mention it in a channel:

```
hello
@OpenCode fix the failing tests
```

When you start a new conversation, the bot shows a **folder picker**:

- **Bookmarks** — your pre-configured project folders as quick buttons
- **Browse** — navigate your filesystem to pick any folder
- **Use default** — skip and use `OPENCODE_DEFAULT_DIR`

Once you pick a folder, your message runs against it.

Example first-message flow:

1. You send: `fix the failing tests`
2. Bot asks you to choose folder (Bookmarks / Browse / Use default)
3. You select folder
4. Bot runs your original message in that folder

### Continue conversation

Reply in the same thread to continue the same OpenCode session.

### Set working directory with dir: prefix

Skip the picker by prefixing your message:

```
dir:/Users/you/my-repo explain this codebase
```

### Folder browser

When you click **Browse**, you get an interactive folder navigator:

- Click folder names to enter them
- **Parent** goes up one level
- **Use this folder** selects the current directory

The browser starts at `OPENCODE_BROWSE_ROOT` and only shows non-hidden directories.

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
- Confirm interactivity is enabled (needed for folder picker buttons)
- Confirm tokens/secrets in `.env` are correct
- Confirm message sender matches `ALLOWED_USER_ID`

### Folder picker buttons don't work

- Go to your Slack app settings → Interactivity & Shortcuts
- Make sure **Interactivity** is turned ON
- With Socket Mode, no Request URL is needed

### No responses in channels, but DM works

- Mention the bot with `@OpenCode ...`
- For thread replies, bot only responds in threads it already started/tracks

## Security considerations

- This bot executes OpenCode instructions with local machine access
- Restrict with `ALLOWED_USER_ID`
- Run under a least-privileged local account
- The folder browser can navigate any readable directory from `OPENCODE_BROWSE_ROOT`
- Be careful when changing `dir:` to sensitive directories
