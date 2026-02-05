import { readFileSync, writeFileSync, watch, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(HOOK_DIR, "pin-state.json");
const TAG = "[status-pin]";

const DEFAULT_CONTEXT_WINDOW = 131_072;

// ---------------------------------------------------------------------------
// Module-level state (persists across hook re-invocations in same process)
// ---------------------------------------------------------------------------

let jsonlWatcher = null;
let sessionsWatcher = null;
let lastUpdateTime = 0;
let cachedBalance = null;
let currentSession = null;
const modelContextCache = new Map(); // model id -> context_length from OpenRouter

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function resolveConfig(event) {
  const openclawHome =
    process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
  const agentId = process.env.STATUS_PIN_AGENT_ID || "main";
  const cooldownMs = parseInt(process.env.STATUS_PIN_COOLDOWN_MS || "3000", 10);
  const sessionsFile = join(
    openclawHome,
    "agents",
    agentId,
    "sessions",
    "sessions.json",
  );

  // Telegram bot token: env var -> event config -> openclaw.json file
  let botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken && event?.context?.cfg?.channels?.telegram?.botToken) {
    botToken = event.context.cfg.channels.telegram.botToken;
  }
  if (!botToken) {
    try {
      const cfgFile = join(openclawHome, "openclaw.json");
      const cfgRaw = readFileSync(cfgFile, "utf-8");
      // Strip JSON5 comments (// and /* */) for safe JSON.parse
      const cfgClean = cfgRaw
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const cfg = JSON.parse(cfgClean);
      botToken = cfg.channels?.telegram?.botToken;
    } catch {
      /* openclaw.json not found or unparseable */
    }
  }

  // OpenRouter API key: env var -> auth profiles
  let openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) {
    try {
      const authFile = join(
        openclawHome,
        "agents",
        agentId,
        "agent",
        "auth-profiles.json",
      );
      const authData = JSON.parse(readFileSync(authFile, "utf-8"));
      const profiles = Object.values(authData.profiles || authData);
      const match = profiles.find((p) => p.provider === "openrouter" && p.key);
      if (match) openrouterKey = match.key;
    } catch {
      /* auth-profiles.json not found or unreadable */
    }
  }

  if (!botToken)
    throw new Error("TELEGRAM_BOT_TOKEN not found in environment or config");
  if (!openrouterKey)
    throw new Error(
      "OPENROUTER_API_KEY not found in environment or auth profiles",
    );

  return {
    agentId,
    cooldownMs,
    sessionsFile,
    botToken,
    openrouterKey,
  };
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

function discoverSession(config) {
  const raw = readFileSync(config.sessionsFile, "utf-8");
  const sessions = JSON.parse(raw);
  const prefix = `agent:${config.agentId}:`;

  for (const [key, entry] of Object.entries(sessions)) {
    if (!key.startsWith(prefix)) continue;

    const sessionFile = entry.sessionFile;
    const model = entry.model || "unknown";

    // Extract chat ID from deliveryContext.to ("telegram:123456789" -> "123456789")
    let chatId = process.env.STATUS_PIN_CHAT_ID;
    if (!chatId && entry.deliveryContext?.to) {
      const match = entry.deliveryContext.to.match(/^telegram:(\d+)$/);
      if (match) chatId = match[1];
    }

    // Context window: env override -> cached model lookup -> null (resolved on startup)
    let contextWindow =
      parseInt(process.env.STATUS_PIN_CONTEXT_WINDOW || "0", 10) ||
      modelContextCache.get(model) ||
      null;

    if (!chatId)
      throw new Error(
        "Could not determine Telegram chat ID from session or STATUS_PIN_CHAT_ID",
      );
    if (!sessionFile) throw new Error(`No sessionFile found for ${key}`);

    return { sessionFile, model, chatId, contextWindow };
  }

  throw new Error(`No session found matching agent:${config.agentId}:*`);
}

// ---------------------------------------------------------------------------
// JSONL parser -- find last assistant message with usage
// ---------------------------------------------------------------------------

function parseLastUsage(sessionFile) {
  if (!existsSync(sessionFile)) return null;

  const raw = readFileSync(sessionFile, "utf-8");
  const lines = raw.trim().split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.message?.role === "assistant" && entry.message?.usage) {
        const u = entry.message.usage;
        return {
          input: u.input || 0,
          output: u.output || 0,
          cacheRead: u.cacheRead || 0,
        };
      }
    } catch {
      /* skip malformed lines */
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// OpenRouter client
// ---------------------------------------------------------------------------

async function fetchContextWindow(apiKey, modelId) {
  // Return cached value if available
  if (modelContextCache.has(modelId)) return modelContextCache.get(modelId);

  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok)
    throw new Error(`OpenRouter /api/v1/models returned ${res.status}`);

  const { data } = await res.json();
  // Cache all models while we have them
  for (const m of data) {
    if (m.context_length) modelContextCache.set(m.id, m.context_length);
  }

  return modelContextCache.get(modelId) || DEFAULT_CONTEXT_WINDOW;
}

async function fetchBalance(apiKey) {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) throw new Error(`OpenRouter /api/v1/key returned ${res.status}`);

  const { data } = await res.json();
  return {
    limit: data.limit, // number | null
    limitRemaining: data.limit_remaining, // number | null
    usage: data.usage, // number
    usageDaily: data.usage_daily, // number
  };
}

// ---------------------------------------------------------------------------
// Telegram client
// ---------------------------------------------------------------------------

async function tgCall(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!json.ok) {
    const err = new Error(
      `Telegram ${method}: ${json.description || res.status}`,
    );
    err.code = json.error_code;
    throw err;
  }
  return json.result;
}

function sendMessage(token, chatId, html) {
  return tgCall(token, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_notification: true,
  });
}

function editMessageText(token, chatId, messageId, html) {
  return tgCall(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: html,
    parse_mode: "HTML",
  });
}

function pinChatMessage(token, chatId, messageId) {
  return tgCall(token, "pinChatMessage", {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true,
  });
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDollars(n, decimals = 2) {
  return `$${n.toFixed(decimals)}`;
}

function balanceIndicator(limit, remaining) {
  if (limit == null || limit === 0) return "\u26AA"; // ⚪ no limit
  const pct = remaining / limit;
  if (pct > 0.25) return "\uD83D\uDFE2"; // 🟢
  if (pct > 0.1) return "\uD83D\uDFE1"; // 🟡
  return "\uD83D\uDD34"; // 🔴
}

function formatStatusMessage(session, usage, balance, staleBalance) {
  const parts = [];
  const sep = " \u2502 "; // │

  // 1. Context %
  const ctxPct = usage
    ? `${Math.round((usage.input / session.contextWindow) * 100)}%`
    : "\u2013%";
  parts.push(`\uD83D\uDCCA ${ctxPct} ctx`);

  // 2. Balance remaining + daily spend
  if (balance) {
    const indicator = balanceIndicator(balance.limit, balance.limitRemaining);
    const staleTag = staleBalance ? "*" : "";
    if (balance.limit != null) {
      parts.push(
        `${indicator} ${fmtDollars(balance.limitRemaining, 2)} left${staleTag}`,
      );
    } else {
      parts.push(
        `${indicator} ${fmtDollars(balance.usage, 2)} used${staleTag}`,
      );
    }
    parts.push(`\uD83D\uDCC5 ${fmtDollars(balance.usageDaily, 2)} today`);
  }

  // 3. Model
  parts.push(`\uD83E\uDD16 ${esc(session.model)}`);

  // 4. Output + cache
  if (usage) {
    const tokenParts = [];
    if (usage.output) tokenParts.push(`\u2197 ${fmtTokens(usage.output)} out`);
    if (usage.cacheRead)
      tokenParts.push(`\uD83D\uDCE6 ${fmtTokens(usage.cacheRead)} cache`);
    if (tokenParts.length) parts.push(tokenParts.join(" "));
  }

  // 5. Timestamp
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  parts.push(`\uD83D\uDD50 ${hh}:${mm}`);

  return parts.join(sep);
}

// ---------------------------------------------------------------------------
// Pin management
// ---------------------------------------------------------------------------

async function ensurePin(config, session, html) {
  const state = loadState();

  // Try to edit existing pin
  if (state?.messageId && state.chatId === session.chatId) {
    try {
      await editMessageText(
        config.botToken,
        session.chatId,
        state.messageId,
        html,
      );
      return state.messageId;
    } catch (err) {
      // "message is not modified" -- content identical, nothing to do
      if (err.code === 400 && /not modified/i.test(err.message)) {
        return state.messageId;
      }
      // Non-400 errors (network, rate-limit, etc.) -- keep state, retry later
      if (err.code !== 400) {
        console.error(TAG, "Edit failed:", err.message);
        return state.messageId;
      }
      // 400 for other reasons = message deleted or not found -- recreate
      console.warn(TAG, "Pinned message gone, creating new one");
    }
  }

  // Create new pin
  const msg = await sendMessage(config.botToken, session.chatId, html);
  const messageId = msg.message_id;

  try {
    await pinChatMessage(config.botToken, session.chatId, messageId);
  } catch (err) {
    console.warn(TAG, "Pin failed (message still sent):", err.message);
  }

  saveState({
    messageId,
    chatId: session.chatId,
    sessionFile: session.sessionFile,
  });
  return messageId;
}

// ---------------------------------------------------------------------------
// Update cycle
// ---------------------------------------------------------------------------

async function runUpdate(config, session) {
  // Debounce
  const now = Date.now();
  if (now - lastUpdateTime < config.cooldownMs) return;
  lastUpdateTime = now;

  // Parse usage
  const usage = parseLastUsage(session.sessionFile);

  // Fetch balance (non-blocking; use cache on failure)
  let staleBalance = false;
  try {
    cachedBalance = await fetchBalance(config.openrouterKey);
  } catch (err) {
    console.warn(TAG, "Balance fetch failed, using cache:", err.message);
    staleBalance = cachedBalance != null;
  }

  // Format and push
  const html = formatStatusMessage(session, usage, cachedBalance, staleBalance);
  await ensurePin(config, session, html);
}

// ---------------------------------------------------------------------------
// File watchers
// ---------------------------------------------------------------------------

function closeWatchers() {
  if (jsonlWatcher) {
    jsonlWatcher.close();
    jsonlWatcher = null;
  }
  if (sessionsWatcher) {
    sessionsWatcher.close();
    sessionsWatcher = null;
  }
}

function watchJsonl(config, session) {
  if (jsonlWatcher) {
    jsonlWatcher.close();
    jsonlWatcher = null;
  }

  if (!existsSync(session.sessionFile)) {
    console.warn(TAG, "Session file not yet created, polling for it...");
    const interval = setInterval(() => {
      if (existsSync(session.sessionFile)) {
        clearInterval(interval);
        watchJsonl(config, session);
      }
    }, 5000);
    return;
  }

  jsonlWatcher = watch(
    session.sessionFile,
    { persistent: false },
    (eventType) => {
      if (eventType === "change") {
        runUpdate(config, session).catch((err) =>
          console.error(TAG, "Update failed:", err.message),
        );
      }
    },
  );

  jsonlWatcher.on("error", (err) => {
    console.error(TAG, "JSONL watcher error:", err.message);
    setTimeout(() => watchJsonl(config, session), 5000);
  });
}

function watchSessions(config, event) {
  if (sessionsWatcher) {
    sessionsWatcher.close();
    sessionsWatcher = null;
  }

  let debounceTimer = null;

  sessionsWatcher = watch(config.sessionsFile, { persistent: false }, () => {
    // Debounce sessions.json changes
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const session = discoverSession(config);

        // Only switch watchers if session file actually changed
        if (
          currentSession &&
          session.sessionFile === currentSession.sessionFile
        ) {
          Object.assign(currentSession, session);
          await runUpdate(config, currentSession);
          return;
        }

        // Resolve context window for new session
        if (!session.contextWindow) {
          try {
            session.contextWindow = await fetchContextWindow(
              config.openrouterKey,
              session.model,
            );
          } catch {
            session.contextWindow = DEFAULT_CONTEXT_WINDOW;
          }
        }

        console.log(TAG, "Session changed:", session.sessionFile);
        currentSession = session;
        watchJsonl(config, session);
        await runUpdate(config, session);
      } catch (err) {
        console.error(TAG, "Session re-discovery failed:", err.message);
      }
    }, 1000);
  });

  sessionsWatcher.on("error", (err) => {
    console.error(TAG, "Sessions watcher error:", err.message);
    setTimeout(() => watchSessions(config, event), 5000);
  });
}

// ---------------------------------------------------------------------------
// Main / Hook entry point
// ---------------------------------------------------------------------------

async function start(event) {
  // Clean up any previous invocation
  closeWatchers();

  const config = resolveConfig(event);
  const session = discoverSession(config);

  // Resolve context window: env override -> OpenRouter API -> default
  if (!session.contextWindow) {
    try {
      session.contextWindow = await fetchContextWindow(
        config.openrouterKey,
        session.model,
      );
      console.log(
        TAG,
        `Context window for ${session.model}: ${session.contextWindow.toLocaleString()} (from OpenRouter)`,
      );
    } catch (err) {
      session.contextWindow = DEFAULT_CONTEXT_WINDOW;
      console.warn(
        TAG,
        `Could not fetch context window, using default ${DEFAULT_CONTEXT_WINDOW}:`,
        err.message,
      );
    }
  } else {
    console.log(
      TAG,
      `Context window: ${session.contextWindow.toLocaleString()} (from STATUS_PIN_CONTEXT_WINDOW)`,
    );
  }

  currentSession = session;

  console.log(TAG, `Model: ${session.model}`);
  console.log(TAG, `Chat ID: ${session.chatId}`);
  console.log(TAG, `Watching: ${session.sessionFile}`);

  // Initial update
  await runUpdate(config, session);

  // Start watchers
  watchJsonl(config, session);
  watchSessions(config, event);

  console.log(TAG, "Running.");
}

// Hook export -- fire-and-forget so we don't block Gateway startup
export default async function handler(event) {
  if (event.type !== "gateway" || event.action !== "startup") return;
  void start(event).catch((err) => console.error(TAG, "Fatal:", err.message));
}

// ---------------------------------------------------------------------------
// Standalone mode: run directly with `node handler.js` for testing
// ---------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(TAG, "Running in standalone mode");
  start(null)
    .then(() => console.log(TAG, "Press Ctrl+C to stop"))
    .catch((err) => {
      console.error(TAG, "Fatal:", err.message);
      process.exit(1);
    });
}
