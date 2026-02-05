# openclaw-status-pin

A lightweight [OpenClaw](https://openclaw.ai/) hook that maintains a **silently-updating pinned message** in your Telegram DM showing real-time context usage and OpenRouter balance.

```
📊 42% ctx │ 🟢 $6.61 left │ 📅 $0.14 today │ 🤖 moonshotai/kimi-k2.5 │ ↗ 405 out 📦 48.1K cache │ 🕐 20:44
```

## How it works

1. Runs as an OpenClaw **hook** — fires on `gateway:startup`, lives inside the Gateway process
2. **Watches** your session JSONL files for changes via `fs.watch`
3. **Parses** the latest assistant message's `usage` block (input/output tokens, cache)
4. **Queries** OpenRouter's `/api/v1/key` endpoint for remaining balance
5. **Updates** a pinned Telegram message via `editMessageText` (silent, no notifications)

The hook runs **outside the agent loop** — it doesn't consume tokens, doesn't interfere with inference, and doesn't require any skills or extra processes. It just reads files and talks to APIs.

## What you see

| Segment          | Meaning                                                    |
| ---------------- | ---------------------------------------------------------- |
| `📊 42% ctx`     | Context window usage — how full the model's memory is      |
| `🟢 $6.61 left`  | OpenRouter balance remaining (🟢 >25%, 🟡 10-25%, 🔴 <10%) |
| `📅 $0.14 today` | Money spent today (UTC)                                    |
| `🤖 model-name`  | Current model                                              |
| `↗ 405 out`      | Tokens generated on the last turn                          |
| `📦 48.1K cache` | Tokens served from cache on the last turn                  |
| `🕐 20:44`       | Last update time                                           |

## Requirements

- **OpenClaw** (with hooks support)
- **Telegram** channel configured in OpenClaw
- **OpenRouter** as your model provider
- **Node.js >= 22** (required by OpenClaw)
- **No npm dependencies** — uses only Node.js built-in modules + `fetch`

## Installation

```bash
# Create the hook directory
mkdir -p ~/.openclaw/hooks/status-pin

# Copy the files
cp HOOK.md handler.js package.json ~/.openclaw/hooks/status-pin/

# Restart the Gateway to load the hook
openclaw gateway restart

# Verify it loaded
openclaw hooks list
```

You should see `📊 status-pin` with status `✓ ready`.

The pinned message will appear in your Telegram DM automatically. Send a message to your OpenClaw bot and the pin will update within a few seconds.

## How it finds your credentials

The hook reads everything from OpenClaw's existing configuration — **no separate `.env` file needed**:

| Value              | Source                                                                           |
| ------------------ | -------------------------------------------------------------------------------- |
| Telegram bot token | `TELEGRAM_BOT_TOKEN` env var, or `channels.telegram.botToken` in `openclaw.json` |
| Telegram chat ID   | Auto-detected from session's `deliveryContext.to`                                |
| OpenRouter API key | `OPENROUTER_API_KEY` env var, or `auth-profiles.json`                            |
| Context window     | Auto-detected from OpenRouter's `/api/v1/models` endpoint                        |

## Configuration

All settings are optional. Set them in `openclaw.json`:

```json5
{
  hooks: {
    internal: {
      entries: {
        "status-pin": {
          enabled: true,
          env: {
            STATUS_PIN_CONTEXT_WINDOW: "131072", // override auto-detected context window
            STATUS_PIN_COOLDOWN_MS: "3000", // min ms between updates (default: 3000)
            STATUS_PIN_AGENT_ID: "main", // agent to monitor (default: main)
            STATUS_PIN_CHAT_ID: "123456789", // override auto-detected chat ID
          },
        },
      },
    },
  },
}
```

## How context percentage is calculated

The hook reads the `input` token count from the last assistant message's `usage` block in the session JSONL file. This value represents the total tokens sent to the model on that turn (system prompt + full conversation history + tool results), which is the best available approximation of how full the context window is.

The context window size is fetched automatically from OpenRouter's models API on startup.

## State persistence

The hook stores the pinned message ID in `pin-state.json` (in the hook directory). This file is auto-created and `.gitignore`d. If you delete it, a new pinned message will be created on the next Gateway restart.

## Scope and future plans

This hook was built for a specific setup: **OpenRouter + Telegram**. It currently only supports these two services.

I'd love to generalize this in the future — supporting other channels (Discord, Slack), other providers (Anthropic direct, OpenAI), and making the status format configurable. Contributions and ideas are welcome!

## Notes

- The 3-second cooldown prevents excessive Telegram API calls — in practice updates only fire when the JSONL file changes, so the actual rate is much lower
- OpenRouter's balance API may lag up to 60 seconds behind actual usage
- If you reset the session (`/reset`), the context bar drops to the new session's usage on the next message
- The hook survives Gateway restarts — it re-reads state from `pin-state.json`
- If you disable the hook, the pinned message stays (unpin manually via Telegram UI)
