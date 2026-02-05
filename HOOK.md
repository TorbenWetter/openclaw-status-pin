---
name: status-pin
description: "Maintains a pinned Telegram message showing real-time context usage and OpenRouter balance"
metadata:
  openclaw:
    emoji: "📊"
    events: ["gateway:startup"]
    export: "default"
---

# Status Pin

Silently maintains a pinned message in your Telegram DM showing:

- Context window usage (progress bar + token counts)
- OpenRouter balance (remaining, used, daily spend)
- Current model name

The hook watches session JSONL files for changes and updates the pin
automatically. It runs entirely outside the agent loop and consumes
no AI tokens.

## Configuration

Optional env vars (set in `openclaw.json` under `hooks.internal.entries.status-pin.env`):

| Variable                    | Default       | Description                  |
| --------------------------- | ------------- | ---------------------------- |
| `STATUS_PIN_CONTEXT_WINDOW` | auto-detected | Override context window size |
| `STATUS_PIN_COOLDOWN_MS`    | `3000`        | Minimum ms between updates   |
| `STATUS_PIN_AGENT_ID`       | `main`        | Agent to monitor             |
| `STATUS_PIN_CHAT_ID`        | auto-detected | Override Telegram chat ID    |
