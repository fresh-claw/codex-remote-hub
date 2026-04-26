import { createServer } from "node:http";
import { createHash, pbkdf2Sync, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const STATE_DB = process.env.CODEX_STATE_DB || path.join(CODEX_HOME, "state_5.sqlite");
const AUTOMATION_DB = process.env.CODEX_AUTOMATION_DB || path.join(CODEX_HOME, "sqlite", "codex-dev.db");
const AUTOMATIONS_DIR = path.join(CODEX_HOME, "automations");
const DEFAULT_CWD = process.env.DEFAULT_CWD || process.cwd();
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((value) => normalizeOrigin(value))
    .filter(Boolean)
);
const ALLOWED_HOSTS = new Set(
  String(process.env.ALLOWED_HOSTS || "127.0.0.1:8787,127.0.0.1,localhost:8787,localhost")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
);
const MAX_BODY_BYTES = Math.max(1024, Number(process.env.MAX_BODY_BYTES || 32 * 1024));
const STATIC_DIR = path.join(__dirname, "public");
const CODEX_CLI_ENTRY = process.env.CODEX_CLI_ENTRY || "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js";
const DEFAULT_EXEC_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const MAX_THREAD_LIST = 40;
const THREAD_CREATURE_LIMIT = 48;
const THREAD_SYNC_INTERVAL_MS = 60 * 1000;
const THREAD_DEAD_THRESHOLD_MS = 15 * 60 * 1000;
const WORK_CENTER_ROOT = __dirname;
const DOC_ACCESS_DIR = path.join(WORK_CENTER_ROOT, "state", "doc_access_inventory");
const DOC_ACCESS_CLAIMS_FILE = path.join(DOC_ACCESS_DIR, "claims.json");
const DOC_ACCESS_WORKER = path.join(WORK_CENTER_ROOT, "scripts", "feishu_auto_sandbox.sh");
const DOC_ACCESS_DOC_TITLE = "Shared access document";
const DOC_ACCESS_DOC_URL = "https://example.com/doc-access";
const DOC_ACCESS_BIND_WINDOW_MS = 10 * 60 * 1000;
const DOC_ACCESS_APPROVE_TIMEOUT_SECONDS = 180;
const AUTOMATION_HUB_DIR = path.join(WORK_CENTER_ROOT, "state", "automation_hub");
const AUTOMATION_HUB_STATE_FILE = path.join(AUTOMATION_HUB_DIR, "state.json");
const THREAD_CHAT_AUTH_FILE = process.env.THREAD_CHAT_AUTH_FILE || path.join(WORK_CENTER_ROOT, "config", "thread_chat_auth.json");
const THREAD_CHAT_SESSION_COOKIE = "codex_thread_chat_session";
const THREAD_CHAT_CSRF_HEADER = "x-thread-chat-csrf";
const THREAD_CHAT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const THREAD_CHAT_MESSAGE_LIMIT = 120;
const AUTOPILOT_DIR = path.join(WORK_CENTER_ROOT, "state", "thread_autopilot");
const AUTOPILOT_CONFIG_FILE = path.join(AUTOPILOT_DIR, "config.json");
const AUTOPILOT_STATE_FILE = path.join(AUTOPILOT_DIR, "state.json");
const AUTOPILOT_TICK_MS = 60 * 1000;
const DOC_ACCESS_BRIDGE_ORIGINS = new Set(
  String(process.env.DOC_ACCESS_BRIDGE_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const activeRuns = new Map();
const sessionCache = new Map();
const WEEKLY_SUGGESTION_SCAN_ROOTS = [
  path.join(CODEX_HOME, "sessions"),
  path.join(CODEX_HOME, "sessions.new"),
  path.join(CODEX_HOME, "archived_sessions"),
];
let weeklySuggestionCache = {
  expiresAt: 0,
  items: [],
};
let docAccessInventoryCache = {
  signature: "",
  items: [],
};
let activeDocAccessRun = null;
let autopilotTickRunning = false;
const threadChatSessions = new Map();
let threadChatAuthCache = {
  mtimeMs: 0,
  config: null,
};

class HttpError extends Error {
  constructor(statusCode, message, headers = {}) {
    super(message);
    this.statusCode = statusCode;
    this.headers = headers;
  }
}

function securityHeaders(contentType, extraHeaders = {}) {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; font-src 'self'",
    ...extraHeaders,
  };
}

function sendJson(res, statusCode, payload, extraHeaders) {
  res.writeHead(statusCode, securityHeaders("application/json; charset=utf-8", extraHeaders));
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8", extraHeaders) {
  res.writeHead(statusCode, securityHeaders(contentType, extraHeaders));
  res.end(text);
}

function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}

function escapeSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function shell(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function sqliteJsonFrom(databasePath, sql) {
  const { stdout } = await shell("sqlite3", ["-json", databasePath, sql]);
  if (!stdout.trim()) {
    return [];
  }
  return JSON.parse(stdout);
}

async function sqliteJson(sql) {
  return sqliteJsonFrom(STATE_DB, sql);
}

async function automationJson(sql) {
  return sqliteJsonFrom(AUTOMATION_DB, sql);
}

function unixSecondsToIso(value) {
  if (!value) return null;
  return new Date(Number(value) * 1000).toISOString();
}

function unixMillisToIso(value) {
  if (!value) return null;
  return new Date(Number(value)).toISOString();
}

function trimText(text, max = 220) {
  if (!text) return "";
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function isoToMillis(value) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function latestIso(...values) {
  let latestValue = null;
  let latestTimestamp = 0;
  for (const value of values) {
    const timestamp = isoToMillis(value);
    if (!timestamp || timestamp < latestTimestamp) continue;
    latestTimestamp = timestamp;
    latestValue = value;
  }
  return latestValue;
}

function parseJsonArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item || "").trim()).filter(Boolean);
  }
  const value = String(raw).trim();
  if (!value) return [];
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || "").trim()).filter(Boolean);
      }
    } catch {
      // Fall through to comma split.
    }
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function describeWeeklyRRule(rrule) {
  const upper = String(rrule || "").toUpperCase();
  if (!upper.includes("FREQ=WEEKLY")) {
    return "每周";
  }

  const weekdays = {
    MO: "周一",
    TU: "周二",
    WE: "周三",
    TH: "周四",
    FR: "周五",
    SA: "周六",
    SU: "周日",
  };

  const byDay = (upper.match(/BYDAY=([^;]+)/)?.[1] || "")
    .split(",")
    .map((entry) => weekdays[entry] || entry)
    .filter(Boolean);
  const byHour = upper.match(/BYHOUR=([^;]+)/)?.[1]?.split(",")[0] || "00";
  const byMinute = upper.match(/BYMINUTE=([^;]+)/)?.[1]?.split(",")[0] || "00";
  const dayLabel = byDay.length ? byDay.join(" / ") : "周";
  return `每${dayLabel} ${pad2(byHour)}:${pad2(byMinute)}`;
}

function normalizeDirectiveText(value) {
  let current = String(value || "");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next = current
      .replace(/\\\\/g, "\\")
      .replace(/\\"/g, "\"")
      .replace(/\\n/g, "\n");
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
}

function parseDirectiveAttributes(text) {
  const attributes = {};
  let cursor = 0;
  while (cursor < text.length) {
    while (cursor < text.length && /[\s,]/.test(text[cursor])) {
      cursor += 1;
    }

    let key = "";
    while (cursor < text.length && /[A-Za-z0-9_]/.test(text[cursor])) {
      key += text[cursor];
      cursor += 1;
    }

    if (!key) {
      cursor += 1;
      continue;
    }

    while (cursor < text.length && /\s/.test(text[cursor])) {
      cursor += 1;
    }

    if (text[cursor] !== "=") {
      continue;
    }
    cursor += 1;

    while (cursor < text.length && /\s/.test(text[cursor])) {
      cursor += 1;
    }

    let value = "";
    if (text[cursor] === "\"") {
      cursor += 1;
      let escaping = false;
      while (cursor < text.length) {
        const ch = text[cursor];
        cursor += 1;
        if (escaping) {
          value += ch;
          escaping = false;
          continue;
        }
        if (ch === "\\") {
          escaping = true;
          continue;
        }
        if (ch === "\"") {
          break;
        }
        value += ch;
      }
    } else {
      while (cursor < text.length && !/[\s,]/.test(text[cursor])) {
        value += text[cursor];
        cursor += 1;
      }
    }

    attributes[key] = value;
  }
  return attributes;
}

function createPlanHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function sameLocalDay(isoString, reference = new Date()) {
  if (!isoString) return false;
  const candidate = new Date(isoString);
  return candidate.getFullYear() === reference.getFullYear()
    && candidate.getMonth() === reference.getMonth()
    && candidate.getDate() === reference.getDate();
}

async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new HttpError(413, "Payload too large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function isLocalHost(hostHeader = "") {
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(hostHeader).trim());
}

function isLoopbackAddress(address = "") {
  return /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(String(address).trim());
}

function normalizeOrigin(value = "") {
  try {
    return new URL(String(value)).origin;
  } catch {
    return "";
  }
}

function assertAuthorized(req, requestUrl) {
  if (requestUrl.pathname === "/healthz") {
    return;
  }

  const hostHeader = String(req.headers.host || "").trim();
  if (!hostHeader || (!ALLOWED_HOSTS.has(hostHeader) && !isLocalHost(hostHeader))) {
    throw new HttpError(403, "Forbidden");
  }

  if (isLocalHost(hostHeader) || isLoopbackAddress(req.socket?.remoteAddress)) {
    return;
  }

  if (!BRIDGE_TOKEN || req.headers["x-codex-bridge-token"] !== BRIDGE_TOKEN) {
    throw new HttpError(403, "Forbidden");
  }
}

function assertSameOrigin(req) {
  const hostHeader = String(req.headers.host || "").trim();
  if (isLocalHost(hostHeader) || !ALLOWED_ORIGINS.size) {
    return;
  }

  const candidate = normalizeOrigin(req.headers.origin) || normalizeOrigin(req.headers.referer);
  if (!candidate || !ALLOWED_ORIGINS.has(candidate)) {
    throw new HttpError(403, "Origin check failed");
  }
}

function docAccessCorsHeaders(req) {
  const hostHeader = String(req.headers.host || "").trim();
  if (!isLocalHost(hostHeader)) {
    return {};
  }

  const origin = normalizeOrigin(req.headers.origin);
  if (!origin || !DOC_ACCESS_BRIDGE_ORIGINS.has(origin)) {
    return {};
  }

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

function assertJsonRequest(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  const cookies = {};
  for (const segment of raw.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) continue;
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function buildSetCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);
  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.expires instanceof Date) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  return parts.join("; ");
}

function threadChatCookieOptions(req, maxAgeSeconds = Math.floor(THREAD_CHAT_SESSION_TTL_MS / 1000)) {
  const hostHeader = String(req.headers.host || "").trim();
  return {
    path: "/",
    httpOnly: true,
    sameSite: "Strict",
    secure: !isLocalHost(hostHeader),
    maxAge: maxAgeSeconds,
  };
}

function cleanupThreadChatSessions() {
  const now = Date.now();
  for (const [sessionId, session] of threadChatSessions.entries()) {
    if (!session || session.expiresAt <= now) {
      threadChatSessions.delete(sessionId);
    }
  }
}

async function loadThreadChatAuthConfig() {
  let stats;
  try {
    stats = await fs.stat(THREAD_CHAT_AUTH_FILE);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new HttpError(500, "Thread chat auth config is missing");
    }
    throw error;
  }

  if (threadChatAuthCache.config && threadChatAuthCache.mtimeMs === stats.mtimeMs) {
    return threadChatAuthCache.config;
  }

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(THREAD_CHAT_AUTH_FILE, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HttpError(500, "Thread chat auth config is invalid");
    }
    throw error;
  }

  const config = parsed && typeof parsed === "object" ? parsed : {};
  const salt = String(config.salt || "").trim();
  const passwordHash = String(config.passwordHash || "").trim().toLowerCase();
  const iterations = Number(config.iterations || 0);
  const keylen = Number(config.keylen || 0);
  const digest = String(config.digest || "").trim() || "sha256";

  if (!/^[a-f0-9]{32,}$/i.test(salt) || !/^[a-f0-9]{32,}$/i.test(passwordHash) || iterations < 100000 || keylen < 16) {
    throw new HttpError(500, "Thread chat auth config is incomplete");
  }

  threadChatAuthCache = {
    mtimeMs: stats.mtimeMs,
    config: {
      salt,
      passwordHash,
      iterations,
      keylen,
      digest,
    },
  };
  return threadChatAuthCache.config;
}

function deriveThreadChatPasswordHash(password, config) {
  return pbkdf2Sync(
    String(password || ""),
    Buffer.from(config.salt, "hex"),
    config.iterations,
    config.keylen,
    config.digest,
  ).toString("hex");
}

function hexEquals(leftHex, rightHex) {
  try {
    const left = Buffer.from(String(leftHex || ""), "hex");
    const right = Buffer.from(String(rightHex || ""), "hex");
    if (left.length === 0 || left.length !== right.length) {
      return false;
    }
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

async function createThreadChatSession() {
  cleanupThreadChatSessions();
  const sessionId = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  const csrfToken = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  const expiresAt = Date.now() + THREAD_CHAT_SESSION_TTL_MS;
  const session = {
    id: sessionId,
    csrfToken,
    expiresAt,
  };
  threadChatSessions.set(sessionId, session);
  return session;
}

function threadChatSessionPayload(session) {
  return {
    authenticated: true,
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

function getThreadChatSession(req, { required = false } = {}) {
  cleanupThreadChatSessions();
  const cookies = parseCookies(req);
  const sessionId = String(cookies[THREAD_CHAT_SESSION_COOKIE] || "").trim();
  if (!sessionId) {
    if (required) {
      throw new HttpError(401, "Authentication required");
    }
    return null;
  }

  const session = threadChatSessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    threadChatSessions.delete(sessionId);
    if (required) {
      throw new HttpError(401, "Authentication required");
    }
    return null;
  }

  session.expiresAt = Date.now() + THREAD_CHAT_SESSION_TTL_MS;
  threadChatSessions.set(sessionId, session);
  return session;
}

function assertThreadChatCsrf(req, session) {
  const token = String(req.headers[THREAD_CHAT_CSRF_HEADER] || "").trim();
  if (!token || token !== session.csrfToken) {
    throw new HttpError(403, "CSRF check failed");
  }
}

function jsonLineToMessage(entry) {
  if (entry.type !== "event_msg" || !entry.payload) return null;
  if (entry.payload.type === "user_message") {
    return {
      role: "user",
      text: String(entry.payload.message || "").trim(),
      timestamp: entry.timestamp,
      phase: null,
    };
  }
  if (entry.payload.type === "agent_message") {
    return {
      role: "assistant",
      text: String(entry.payload.message || "").trim(),
      timestamp: entry.timestamp,
      phase: entry.payload.phase || null,
    };
  }
  if (entry.payload.type === "agent_reasoning") {
    return {
      role: "system",
      text: trimText(entry.payload.text || "Agent reasoning"),
      timestamp: entry.timestamp,
      phase: "reasoning",
    };
  }
  if (entry.payload.type === "task_started") {
    return {
      role: "system",
      text: "Task started",
      timestamp: entry.timestamp,
      phase: "task_started",
    };
  }
  if (entry.payload.type === "task_complete") {
    return {
      role: "system",
      text: "Task completed",
      timestamp: entry.timestamp,
      phase: "task_complete",
    };
  }
  return null;
}

function deriveStatus(entries) {
  let status = "idle";
  for (const entry of entries) {
    if (entry.type === "turn.started") {
      status = "running";
      continue;
    }
    if (entry.type === "turn.completed") {
      status = "idle";
      continue;
    }
    if (entry.type !== "event_msg" || !entry.payload) {
      continue;
    }
    if (entry.payload.type === "task_started" || entry.payload.type === "agent_reasoning") {
      status = "running";
      continue;
    }
    if (entry.payload.type === "task_complete") {
      status = "idle";
    }
  }
  return status;
}

function inferReasoningKind(text) {
  const value = String(text || "").toLowerCase();
  if (!value) return "background_reasoning";
  if (/(compress|compaction|summary|summariz|background|context|压缩|上下文|背景|整理)/.test(value)) {
    return "background_compaction";
  }
  return "background_reasoning";
}

function summarizeSessionActivity(entries) {
  const activity = {
    lastEventAt: null,
    lastProgressAt: null,
    lastVisibleAt: null,
    lastReasoningAt: null,
    lastTaskStartedAt: null,
    lastTaskCompleteAt: null,
    lastTurnStartedAt: null,
    lastTurnCompletedAt: null,
    lastUserAt: null,
    lastAssistantAt: null,
    reasoningKind: null,
  };

  for (const entry of entries) {
    const timestamp = entry.timestamp || null;
    activity.lastEventAt = latestIso(activity.lastEventAt, timestamp);

    if (entry.type === "response_item" && entry.payload?.type === "reasoning") {
      activity.lastReasoningAt = latestIso(activity.lastReasoningAt, timestamp);
      activity.reasoningKind = activity.reasoningKind || "background_reasoning";
      continue;
    }

    if (entry.type === "turn.started") {
      activity.lastTurnStartedAt = latestIso(activity.lastTurnStartedAt, timestamp);
      activity.lastProgressAt = latestIso(activity.lastProgressAt, timestamp);
      continue;
    }

    if (entry.type === "turn.completed") {
      activity.lastTurnCompletedAt = latestIso(activity.lastTurnCompletedAt, timestamp);
      activity.lastProgressAt = latestIso(activity.lastProgressAt, timestamp);
      continue;
    }

    if (entry.type !== "event_msg" || !entry.payload) {
      continue;
    }

    if (entry.payload.type === "user_message") {
      activity.lastUserAt = latestIso(activity.lastUserAt, timestamp);
      activity.lastVisibleAt = latestIso(activity.lastVisibleAt, timestamp);
      activity.lastProgressAt = latestIso(activity.lastProgressAt, timestamp);
      continue;
    }

    if (entry.payload.type === "agent_message") {
      activity.lastAssistantAt = latestIso(activity.lastAssistantAt, timestamp);
      activity.lastVisibleAt = latestIso(activity.lastVisibleAt, timestamp);
      activity.lastProgressAt = latestIso(activity.lastProgressAt, timestamp);
      continue;
    }

    if (entry.payload.type === "agent_reasoning") {
      activity.lastReasoningAt = latestIso(activity.lastReasoningAt, timestamp);
      activity.lastProgressAt = latestIso(activity.lastProgressAt, timestamp);
      activity.reasoningKind = inferReasoningKind(entry.payload.text);
      continue;
    }

    if (entry.payload.type === "task_started") {
      activity.lastTaskStartedAt = latestIso(activity.lastTaskStartedAt, timestamp);
      activity.lastProgressAt = latestIso(activity.lastProgressAt, timestamp);
      continue;
    }

    if (entry.payload.type === "task_complete") {
      activity.lastTaskCompleteAt = latestIso(activity.lastTaskCompleteAt, timestamp);
      activity.lastProgressAt = latestIso(activity.lastProgressAt, timestamp);
    }
  }

  return activity;
}

function collapseToRecentRounds(messages, roundLimit = 2) {
  const visible = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const rounds = [];
  let currentRound = null;

  for (const message of visible) {
    if (message.role === "user") {
      if (currentRound) {
        rounds.push(currentRound);
      }
      currentRound = {
        user: message,
        assistant: null,
      };
      continue;
    }

    if (!currentRound) {
      currentRound = {
        user: null,
        assistant: message,
      };
      continue;
    }

    currentRound.assistant = message;
  }

  if (currentRound) {
    rounds.push(currentRound);
  }

  return rounds
    .slice(-roundLimit)
    .flatMap((round) => [round.user, round.assistant].filter(Boolean));
}

function tailMessages(messages, limit = THREAD_CHAT_MESSAGE_LIMIT, includeSystem = false) {
  const visible = includeSystem
    ? messages
    : messages.filter((message) => message.role === "user" || message.role === "assistant");
  return visible.slice(-Math.max(1, Math.min(Number(limit) || THREAD_CHAT_MESSAGE_LIMIT, 240)));
}

async function parseSessionFile(sessionPath, includeMessages = false, options = {}) {
  const messageMode = options.messageMode === "tail" ? "tail" : "rounds";
  const messageLimit = Math.max(1, Math.min(Number(options.messageLimit) || THREAD_CHAT_MESSAGE_LIMIT, 240));
  const includeSystemMessages = options.includeSystemMessages === true;
  const fullCacheKey = `${messageMode}:${messageLimit}:${includeSystemMessages ? "sys" : "visible"}`;
  if (!sessionPath) {
    return {
      status: "missing",
      preview: "",
      lastMessageAt: null,
      messageCount: 0,
      messages: [],
    };
  }

  const stats = await fs.stat(sessionPath);
  const cacheKey = sessionPath;
  const cached = sessionCache.get(cacheKey);
  if (cached && cached.mtimeMs === stats.mtimeMs) {
    if (!includeMessages && cached.summary) {
      return cached.summary;
    }
    if (includeMessages && cached.fulls?.has(fullCacheKey)) {
      return cached.fulls.get(fullCacheKey);
    }
  }

  const text = await fs.readFile(sessionPath, "utf8");
  const entries = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Ignore corrupted lines at file tail.
    }
  }

  const messages = [];
  for (const entry of entries) {
    const parsed = jsonLineToMessage(entry);
    if (parsed) {
      messages.push(parsed);
    }
  }

  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const lastMessage = [...messages].reverse().find((message) => message.role !== "system");
  const activity = summarizeSessionActivity(entries);

  const summary = {
    status: deriveStatus(entries),
    preview: trimText(lastAssistant?.text || lastUser?.text || ""),
    lastMessageAt: lastMessage?.timestamp || null,
    lastUserMessage: lastUser?.text || "",
    lastAssistantMessage: lastAssistant?.text || "",
    messageCount: messages.filter((message) => message.role !== "system").length,
    lastEventAt: activity.lastEventAt,
    lastProgressAt: latestIso(activity.lastProgressAt, activity.lastEventAt, lastMessage?.timestamp || null),
    lastVisibleAt: latestIso(activity.lastVisibleAt, lastMessage?.timestamp || null),
    lastReasoningAt: activity.lastReasoningAt,
    lastTaskStartedAt: activity.lastTaskStartedAt,
    lastTaskCompleteAt: activity.lastTaskCompleteAt,
    lastTurnStartedAt: activity.lastTurnStartedAt,
    lastTurnCompletedAt: activity.lastTurnCompletedAt,
    lastUserAt: activity.lastUserAt,
    lastAssistantAt: activity.lastAssistantAt,
    reasoningKind: activity.reasoningKind,
  };

  const full = {
    ...summary,
    messages: messageMode === "tail"
      ? tailMessages(messages, messageLimit, includeSystemMessages)
      : collapseToRecentRounds(messages, 2),
  };

  const fulls = cached && cached.mtimeMs === stats.mtimeMs && cached.fulls instanceof Map
    ? cached.fulls
    : new Map();
  fulls.set(fullCacheKey, full);
  sessionCache.set(cacheKey, { mtimeMs: stats.mtimeMs, summary, fulls });
  return includeMessages ? full : summary;
}

async function collectJsonlFiles(rootPath, bucket = []) {
  let entries = [];
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch {
    return bucket;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(fullPath, bucket);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    try {
      const stats = await fs.stat(fullPath);
      bucket.push({
        filePath: fullPath,
        mtimeMs: stats.mtimeMs,
      });
    } catch {
      // Ignore disappearing files.
    }
  }

  return bucket;
}

async function querySuggestedWeeklyPlans() {
  if (weeklySuggestionCache.expiresAt > Date.now()) {
    return weeklySuggestionCache.items;
  }

  const files = [];
  for (const rootPath of WEEKLY_SUGGESTION_SCAN_ROOTS) {
    await collectJsonlFiles(rootPath, files);
  }

  const recentFiles = files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, 120);

  const plans = [];
  const seen = new Set();

  for (const fileEntry of recentFiles) {
    let text = "";
    try {
      text = await fs.readFile(fileEntry.filePath, "utf8");
    } catch {
      continue;
    }

    if (!text.includes("automation-update")) {
      continue;
    }

    const matches = text.match(/::automation-update\{[\s\S]*?\}/g) || [];
    for (const rawMatch of matches) {
      const normalized = normalizeDirectiveText(rawMatch);
      const inner = normalized.match(/::automation-update\{([\s\S]*?)\}/)?.[1];
      if (!inner) {
        continue;
      }

      const attrs = parseDirectiveAttributes(inner);
      const rrule = String(attrs.rrule || "").trim();
      const mode = String(attrs.mode || "").trim().toLowerCase();
      if (!rrule.toUpperCase().includes("FREQ=WEEKLY") || mode === "view") {
        continue;
      }

      const prompt = String(attrs.prompt || "").trim();
      const name = String(attrs.name || "").trim() || trimText(prompt, 64) || "未命名周计划";
      const workspaces = parseJsonArray(attrs.cwds);
      const dedupeKey = `${name.toLowerCase()}::${prompt}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      plans.push({
        id: `suggested-${createPlanHash(`${fileEntry.filePath}:${dedupeKey}`)}`,
        kind: "suggested",
        name,
        status: String(attrs.status || "SUGGESTED").trim().toUpperCase(),
        scheduleLabel: describeWeeklyRRule(rrule),
        nextRunAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        lastRunThreadId: null,
        lastRunTitle: null,
        workspaces,
        primaryCwd: workspaces[0] || DEFAULT_CWD,
        extraCwds: workspaces.slice(1),
        prompt,
        promptPreview: trimText(prompt, 240),
        sourceLabel: "线程建议",
        sourcePath: fileEntry.filePath,
        updatedAt: new Date(fileEntry.mtimeMs).toISOString(),
        activeRun: null,
      });
    }
  }

  weeklySuggestionCache = {
    expiresAt: Date.now() + 60 * 1000,
    items: plans,
  };
  return plans;
}

async function queryInstalledWeeklyPlans() {
  const rows = await automationJson(`
    select
      id,
      name,
      prompt,
      status,
      next_run_at,
      last_run_at,
      cwds,
      rrule,
      created_at,
      updated_at
    from automations
    where upper(rrule) like '%FREQ=WEEKLY%'
    order by
      case when next_run_at is null then 1 else 0 end,
      next_run_at asc,
      updated_at desc
  `);

  const latestRuns = new Map();
  const runRows = await automationJson(`
    select
      automation_id,
      status,
      thread_id,
      thread_title,
      source_cwd,
      inbox_title,
      created_at,
      updated_at
    from automation_runs
    order by updated_at desc
    limit 200
  `);

  for (const row of runRows) {
    if (!latestRuns.has(row.automation_id)) {
      latestRuns.set(row.automation_id, row);
    }
  }

  const activeRunsByPlanId = new Map(
    [...activeRuns.values()]
      .filter((run) => run.planId && run.status === "running")
      .map((run) => [run.planId, run]),
  );

  return rows.map((row) => {
    const workspaces = parseJsonArray(row.cwds);
    const latestRun = latestRuns.get(row.id) || null;
    const activeRun = activeRunsByPlanId.get(row.id) || null;
    return {
      id: row.id,
      kind: "installed",
      name: row.name,
      status: String(row.status || "ACTIVE").toUpperCase(),
      scheduleLabel: describeWeeklyRRule(row.rrule),
      nextRunAt: unixMillisToIso(row.next_run_at),
      lastRunAt: unixMillisToIso(row.last_run_at) || unixMillisToIso(latestRun?.updated_at),
      lastRunStatus: latestRun?.status || null,
      lastRunThreadId: latestRun?.thread_id || null,
      lastRunTitle: latestRun?.thread_title || latestRun?.inbox_title || null,
      workspaces,
      primaryCwd: workspaces[0] || DEFAULT_CWD,
      extraCwds: workspaces.slice(1),
      prompt: row.prompt,
      promptPreview: trimText(row.prompt, 240),
      sourceLabel: "已安装",
      sourcePath: path.join(AUTOMATIONS_DIR, row.id, "automation.toml"),
      updatedAt: unixMillisToIso(row.updated_at),
      activeRun: activeRun
        ? {
            id: activeRun.id,
            status: activeRun.status,
            threadId: activeRun.threadId,
            startedAt: activeRun.startedAt,
          }
        : null,
    };
  });
}

async function queryWeeklyPlans() {
  const installed = await queryInstalledWeeklyPlans();
  const installedNames = new Set(installed.map((plan) => String(plan.name || "").trim().toLowerCase()).filter(Boolean));
  const suggested = (await querySuggestedWeeklyPlans())
    .filter((plan) => !installedNames.has(String(plan.name || "").trim().toLowerCase()));

  const plans = [...installed, ...suggested].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "installed" ? -1 : 1;
    }
    if (left.nextRunAt && right.nextRunAt) {
      return new Date(left.nextRunAt).getTime() - new Date(right.nextRunAt).getTime();
    }
    if (left.nextRunAt) return -1;
    if (right.nextRunAt) return 1;
    return String(left.name || "").localeCompare(String(right.name || ""));
  });

  const stats = {
    total: plans.length,
    installed: installed.length,
    suggested: suggested.length,
    active: installed.filter((plan) => plan.status === "ACTIVE").length,
    dueToday: installed.filter((plan) => sameLocalDay(plan.nextRunAt)).length,
  };

  return { plans, stats };
}

async function queryThreads(limit = MAX_THREAD_LIST) {
  const sql = `
    select
      id,
      title,
      cwd,
      source,
      rollout_path,
      created_at,
      updated_at,
      archived
    from threads
    order by updated_at desc
    limit ${Math.max(1, Math.min(Number(limit) || MAX_THREAD_LIST, 100))}
  `;
  const rows = await sqliteJson(sql);
  const enriched = [];
  for (const row of rows) {
    const session = await parseSessionFile(row.rollout_path, false);
    const run = [...activeRuns.values()].find((item) => item.threadId === row.id && item.status === "running");
    enriched.push({
      id: row.id,
      title: row.title,
      updatedAt: unixSecondsToIso(row.updated_at),
      status: run ? "running" : session.status,
    });
  }
  return enriched;
}

async function queryThread(threadId) {
  const sql = `
    select
      id,
      title,
      cwd,
      source,
      rollout_path,
      created_at,
      updated_at,
      archived
    from threads
    where id = ${escapeSql(threadId)}
    limit 1
  `;
  const rows = await sqliteJson(sql);
  return rows[0] || null;
}

async function queryThreadChatThreads(limit = MAX_THREAD_LIST) {
  const sql = `
    select
      id,
      title,
      cwd,
      source,
      rollout_path,
      created_at,
      updated_at,
      archived
    from threads
    order by updated_at desc
    limit ${Math.max(1, Math.min(Number(limit) || MAX_THREAD_LIST, 100))}
  `;
  const rows = await sqliteJson(sql);
  const nowMs = Date.now();
  const items = [];

  for (const row of rows) {
    const session = await parseSessionFile(row.rollout_path, false);
    const activeRun = [...activeRuns.values()].find((item) => item.threadId === row.id && item.status === "running") || null;
    const creature = classifyThreadCreature(row, session, activeRun, nowMs);
    items.push({
      id: row.id,
      title: row.title || "未命名线程",
      updatedAt: unixSecondsToIso(row.updated_at),
      state: creature.state,
      stateLabel: creature.stateLabel,
      canSend: creature.canSend,
      lastActiveAt: creature.lastActiveAt,
      preview: trimText(session.preview || "", 72),
    });
  }

  return {
    threads: items,
    syncIntervalMs: THREAD_SYNC_INTERVAL_MS,
    serverTime: new Date(nowMs).toISOString(),
  };
}

async function queryThreadChatThread(threadId) {
  const thread = await queryThread(threadId);
  if (!thread) {
    return null;
  }

  const [session, activeRun] = await Promise.all([
    parseSessionFile(thread.rollout_path, true, {
      messageMode: "tail",
      messageLimit: THREAD_CHAT_MESSAGE_LIMIT,
      includeSystemMessages: false,
    }),
    Promise.resolve([...activeRuns.values()].find((run) => run.threadId === threadId && run.status === "running") || null),
  ]);

  const meta = classifyThreadCreature(thread, session, activeRun, Date.now());
  return {
    thread: {
      id: thread.id,
      title: thread.title || "未命名线程",
      updatedAt: unixSecondsToIso(thread.updated_at),
      state: meta.state,
      stateLabel: meta.stateLabel,
      stateHint: meta.stateHint,
      canSend: meta.canSend,
      lastActiveAt: meta.lastActiveAt,
      preview: trimText(session.preview || "", 90),
    },
    session,
    activeRun,
  };
}

function classifyThreadCreature(thread, session, activeRun, nowMs = Date.now()) {
  const threadUpdatedAt = unixSecondsToIso(thread.updated_at);
  const lastActiveAt = latestIso(
    activeRun?.startedAt || null,
    session.lastProgressAt,
    session.lastVisibleAt,
    session.lastMessageAt,
    threadUpdatedAt,
  );
  const staleMs = lastActiveAt ? Math.max(0, nowMs - isoToMillis(lastActiveAt)) : 0;
  const remotelyRunning = session.status === "running";
  const locallyRunning = activeRun?.status === "running";
  const isRunning = Boolean(locallyRunning || remotelyRunning);
  const isDead = isRunning && staleMs >= THREAD_DEAD_THRESHOLD_MS;
  const deadFromBackgroundReasoning = ["background_compaction", "background_reasoning"].includes(session.reasoningKind || "");

  let state = "waiting";
  let stateLabel = "等待新指令";
  let stateHint = "已经跑完，等你下一句。";

  if (isRunning && !isDead) {
    state = "running";
    stateLabel = "正在执行";
    stateHint = "还在跑，卡通会持续动。";
  } else if (isDead) {
    state = "dead";
    stateLabel = "卡通死亡";
    stateHint = deadFromBackgroundReasoning
      ? "后台压缩/整理超过15分钟没有推进。"
      : "线程超过15分钟没有推进。";
  }

  return {
    id: thread.id,
    title: trimText(thread.title || "未命名线程", 96),
    rawTitle: thread.title || "",
    cwd: thread.cwd || DEFAULT_CWD,
    updatedAt: threadUpdatedAt,
    lastActiveAt,
    staleMinutes: Math.floor(staleMs / 60000),
    deadAfterMinutes: Math.floor(THREAD_DEAD_THRESHOLD_MS / 60000),
    state,
    stateLabel,
    stateHint,
    canSend: !locallyRunning,
    sessionStatus: session.status,
    reasoningKind: session.reasoningKind || null,
    lastTaskStartedAt: session.lastTaskStartedAt || null,
    lastTaskCompleteAt: session.lastTaskCompleteAt || null,
    lastAssistantAt: session.lastAssistantAt || null,
    lastUserAt: session.lastUserAt || null,
    lastMessageAt: session.lastMessageAt || null,
    preview: trimText(session.preview || "", 120),
    activeRun: activeRun
      ? {
          id: activeRun.id,
          status: activeRun.status,
          startedAt: activeRun.startedAt,
        }
      : null,
  };
}

async function queryThreadCreatures(limit = THREAD_CREATURE_LIMIT) {
  const sql = `
    select
      id,
      title,
      cwd,
      source,
      rollout_path,
      created_at,
      updated_at,
      archived
    from threads
    order by updated_at desc
    limit ${Math.max(1, Math.min(Number(limit) || THREAD_CREATURE_LIMIT, 120))}
  `;
  const rows = await sqliteJson(sql);
  const nowMs = Date.now();
  const creatures = [];

  for (const row of rows) {
    const session = await parseSessionFile(row.rollout_path, false);
    const activeRun = [...activeRuns.values()].find((item) => item.threadId === row.id && item.status === "running") || null;
    creatures.push(classifyThreadCreature(row, session, activeRun, nowMs));
  }

  const priority = {
    dead: 0,
    running: 1,
    waiting: 2,
  };

  creatures.sort((left, right) => {
    const leftPriority = priority[left.state] ?? 9;
    const rightPriority = priority[right.state] ?? 9;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return isoToMillis(right.lastActiveAt || right.updatedAt) - isoToMillis(left.lastActiveAt || left.updatedAt);
  });

  return {
    threads: creatures,
    stats: {
      total: creatures.length,
      running: creatures.filter((item) => item.state === "running").length,
      waiting: creatures.filter((item) => item.state === "waiting").length,
      dead: creatures.filter((item) => item.state === "dead").length,
    },
    syncIntervalMs: THREAD_SYNC_INTERVAL_MS,
    deadAfterMs: THREAD_DEAD_THRESHOLD_MS,
    serverTime: new Date(nowMs).toISOString(),
  };
}

async function queryThreadNudgerThreads(limit = MAX_THREAD_LIST) {
  const sql = `
    select
      id,
      title,
      cwd,
      source,
      rollout_path,
      created_at,
      updated_at,
      archived
    from threads
    order by updated_at desc
    limit ${Math.max(1, Math.min(Number(limit) || MAX_THREAD_LIST, 120))}
  `;
  const rows = await sqliteJson(sql);
  const nowMs = Date.now();
  const items = [];

  for (const row of rows) {
    const session = await parseSessionFile(row.rollout_path, false);
    const activeRun = [...activeRuns.values()].find((item) => item.threadId === row.id && item.status === "running") || null;
    const meta = classifyThreadCreature(row, session, activeRun, nowMs);
    items.push({
      id: row.id,
      title: row.title || "未命名线程",
      cwd: row.cwd || DEFAULT_CWD,
      archived: Boolean(row.archived),
      updatedAt: unixSecondsToIso(row.updated_at),
      state: meta.state,
      stateLabel: meta.stateLabel,
      canSend: meta.canSend,
      lastActiveAt: meta.lastActiveAt,
      lastUserAt: session.lastUserAt || null,
      lastAssistantAt: session.lastAssistantAt || null,
      lastMessageAt: session.lastMessageAt || null,
      reasoningKind: session.reasoningKind || null,
      sessionStatus: session.status || "idle",
      preview: trimText(session.preview || "", 120),
    });
  }

  return {
    threads: items,
    syncIntervalMs: THREAD_SYNC_INTERVAL_MS,
    serverTime: new Date(nowMs).toISOString(),
  };
}

const DEFAULT_AUTOPILOT_CONFIG = {
  enabled: false,
  intervalMinutes: 15,
  cooldownMinutes: 15,
  threadLimit: 40,
  maxThreadsPerTick: 2,
  recentThreadHours: 72,
  requireAssistantLast: true,
  onlyStates: ["waiting", "dead"],
  completionPatterns: ["已完成", "完成了", "done", "finished", "task completed"],
  dangerPatterns: ["删除全部", "清空", "付款", "转账", "发布到线上", "公开仓库", "reset --hard"],
  scripts: [
    {
      id: "night-default",
      name: "夜间继续",
      enabled: true,
      mode: "sequence",
      steps: [
        { condition: "idle", message: "继续" },
        { condition: "idle", message: "进度？" },
        { condition: "idle", message: "请拆下一步并继续执行，完成后说明结果。" },
      ],
    },
  ],
  threadRules: {},
};

function normalizeTextList(value, fallback = []) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split("\n").map((item) => item.trim()).filter(Boolean);
  }
  return [...fallback];
}

function normalizeAutopilotStep(step) {
  const item = step && typeof step === "object" ? step : {};
  return {
    condition: ["idle", "waiting", "dead", "contains", "always"].includes(item.condition) ? item.condition : "idle",
    match: String(item.match || "").trim(),
    message: String(item.message || "").trim(),
  };
}

function normalizeAutopilotScript(script, index = 0) {
  const item = script && typeof script === "object" ? script : {};
  const steps = Array.isArray(item.steps) ? item.steps.map(normalizeAutopilotStep).filter((step) => step.message) : [];
  return {
    id: String(item.id || `script-${index + 1}`).trim(),
    name: String(item.name || `编排 ${index + 1}`).trim(),
    enabled: item.enabled !== false,
    mode: item.mode === "first-match" ? "first-match" : "sequence",
    steps: steps.length ? steps : DEFAULT_AUTOPILOT_CONFIG.scripts[0].steps,
  };
}

function normalizeAutopilotConfig(raw = {}) {
  const scripts = Array.isArray(raw.scripts)
    ? raw.scripts.map(normalizeAutopilotScript).filter((script) => script.steps.length)
    : [];
  const threadRules = raw.threadRules && typeof raw.threadRules === "object" && !Array.isArray(raw.threadRules)
    ? raw.threadRules
    : {};
  return {
    ...DEFAULT_AUTOPILOT_CONFIG,
    ...raw,
    enabled: raw.enabled === true,
    intervalMinutes: Math.max(1, Number(raw.intervalMinutes) || DEFAULT_AUTOPILOT_CONFIG.intervalMinutes),
    cooldownMinutes: Math.max(1, Number(raw.cooldownMinutes) || DEFAULT_AUTOPILOT_CONFIG.cooldownMinutes),
    threadLimit: Math.max(1, Math.min(Number(raw.threadLimit) || DEFAULT_AUTOPILOT_CONFIG.threadLimit, 120)),
    maxThreadsPerTick: Math.max(1, Math.min(Number(raw.maxThreadsPerTick) || DEFAULT_AUTOPILOT_CONFIG.maxThreadsPerTick, 20)),
    recentThreadHours: Math.max(1, Number(raw.recentThreadHours) || DEFAULT_AUTOPILOT_CONFIG.recentThreadHours),
    requireAssistantLast: raw.requireAssistantLast !== false,
    onlyStates: normalizeTextList(raw.onlyStates, DEFAULT_AUTOPILOT_CONFIG.onlyStates),
    completionPatterns: normalizeTextList(raw.completionPatterns, DEFAULT_AUTOPILOT_CONFIG.completionPatterns),
    dangerPatterns: normalizeTextList(raw.dangerPatterns, DEFAULT_AUTOPILOT_CONFIG.dangerPatterns),
    scripts: scripts.length ? scripts : DEFAULT_AUTOPILOT_CONFIG.scripts,
    threadRules,
  };
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempFile, filePath);
}

async function readAutopilotConfig() {
  return normalizeAutopilotConfig(await readJsonFile(AUTOPILOT_CONFIG_FILE, DEFAULT_AUTOPILOT_CONFIG));
}

async function writeAutopilotConfig(config) {
  const normalized = normalizeAutopilotConfig(config);
  await writeJsonFile(AUTOPILOT_CONFIG_FILE, normalized);
  return normalized;
}

async function readAutopilotState() {
  const state = await readJsonFile(AUTOPILOT_STATE_FILE, {
    version: 1,
    lastTickAt: null,
    updatedAt: null,
    threads: {},
    history: [],
  });
  return {
    version: 1,
    lastTickAt: null,
    updatedAt: null,
    threads: {},
    history: [],
    ...state,
  };
}

async function writeAutopilotState(state) {
  await writeJsonFile(AUTOPILOT_STATE_FILE, {
    ...state,
    updatedAt: new Date().toISOString(),
  });
}

function autopilotLastSpeaker(thread) {
  const assistantAt = isoToMillis(thread.lastAssistantAt);
  const userAt = isoToMillis(thread.lastUserAt);
  if (!assistantAt && !userAt) return null;
  return assistantAt >= userAt ? "assistant" : "user";
}

function textContainsAny(text, patterns) {
  const haystack = String(text || "").toLowerCase();
  return patterns.some((pattern) => haystack.includes(String(pattern || "").toLowerCase()));
}

function autopilotStepMatches(step, thread) {
  if (step.condition === "always") return true;
  if (step.condition === "waiting") return thread.state === "waiting";
  if (step.condition === "dead") return thread.state === "dead";
  if (step.condition === "contains") {
    return step.match && textContainsAny(`${thread.preview || ""}\n${thread.title || ""}`, [step.match]);
  }
  return thread.state === "waiting" || thread.state === "dead";
}

function getAutopilotThreadEntry(state, threadId) {
  if (!state.threads || typeof state.threads !== "object") {
    state.threads = {};
  }
  if (!state.threads[threadId]) {
    state.threads[threadId] = {
      enabled: true,
      scriptId: null,
      cursor: 0,
      lastSentAt: null,
      pausedReason: null,
      history: [],
    };
  }
  return state.threads[threadId];
}

function chooseAutopilotScript(config, entry) {
  const scriptId = String(entry.scriptId || "").trim();
  const scripts = config.scripts.filter((script) => script.enabled);
  return scripts.find((script) => script.id === scriptId) || scripts[0] || null;
}

function chooseAutopilotPrompt(config, entry, thread) {
  const script = chooseAutopilotScript(config, entry);
  if (!script) return { prompt: "", script: null, step: null };
  const steps = script.steps.filter((step) => step.message);
  if (!steps.length) return { prompt: "", script, step: null };

  if (script.mode === "first-match") {
    const step = steps.find((item) => autopilotStepMatches(item, thread)) || null;
    return { prompt: step?.message || "", script, step };
  }

  for (let offset = 0; offset < steps.length; offset += 1) {
    const index = (entry.cursor + offset) % steps.length;
    const step = steps[index];
    if (!autopilotStepMatches(step, thread)) continue;
    entry.cursor = index + 1;
    return { prompt: step.message, script, step };
  }
  return { prompt: "", script, step: null };
}

function autopilotThreadSkipReason(config, state, thread, nowMs) {
  const entry = getAutopilotThreadEntry(state, thread.id);
  if (entry.enabled === false) return "线程已暂停";
  if (!config.onlyStates.includes(thread.state)) return `状态不匹配：${thread.stateLabel || thread.state}`;
  if (!thread.canSend) return "线程正在执行";
  if (config.requireAssistantLast && autopilotLastSpeaker(thread) !== "assistant") return "最后一条不是 Codex";
  if (textContainsAny(thread.preview || "", config.completionPatterns)) return "疑似已完成";

  const lastActiveMs = isoToMillis(thread.lastActiveAt || thread.updatedAt);
  if (!lastActiveMs) return "没有活动时间";
  if (nowMs - lastActiveMs < config.intervalMinutes * 60 * 1000) return "未到间隔";

  const updatedMs = isoToMillis(thread.updatedAt || thread.lastActiveAt);
  if (!updatedMs || nowMs - updatedMs > config.recentThreadHours * 60 * 60 * 1000) return "线程过旧";

  const lastSentMs = isoToMillis(entry.lastSentAt);
  if (lastSentMs && nowMs - lastSentMs < config.cooldownMinutes * 60 * 1000) return "冷却中";
  return "";
}

async function runAutopilotTick({ force = false } = {}) {
  if (autopilotTickRunning) {
    return { skipped: true, reason: "tick-running" };
  }

  autopilotTickRunning = true;
  try {
    const config = await readAutopilotConfig();
    const state = await readAutopilotState();
    const now = new Date();
    const nowMs = now.getTime();
    const sent = [];
    const skipped = [];

    if (!config.enabled && !force) {
      state.lastTickAt = now.toISOString();
      await writeAutopilotState(state);
      return { config, state, sent, skipped, disabled: true, serverTime: now.toISOString() };
    }

    const payload = await queryThreadNudgerThreads(config.threadLimit);
    for (const thread of payload.threads) {
      const entry = getAutopilotThreadEntry(state, thread.id);
      const reason = force ? "" : autopilotThreadSkipReason(config, state, thread, nowMs);
      if (reason) {
        skipped.push({ threadId: thread.id, title: thread.title, reason });
        continue;
      }

      const { prompt, script, step } = chooseAutopilotPrompt(config, entry, thread);
      if (!prompt) {
        skipped.push({ threadId: thread.id, title: thread.title, reason: "没有匹配话术" });
        continue;
      }
      if (textContainsAny(prompt, config.dangerPatterns)) {
        entry.pausedReason = "话术命中危险词";
        skipped.push({ threadId: thread.id, title: thread.title, reason: entry.pausedReason });
        continue;
      }

      const run = spawnCodexRun({ mode: "resume", threadId: thread.id, prompt, cwd: thread.cwd || DEFAULT_CWD });
      const record = {
        at: new Date().toISOString(),
        threadId: thread.id,
        title: thread.title,
        prompt,
        scriptId: script?.id || null,
        scriptName: script?.name || null,
        condition: step?.condition || null,
        runId: run.id,
      };
      entry.lastSentAt = record.at;
      entry.pausedReason = null;
      entry.history = [record, ...(Array.isArray(entry.history) ? entry.history : [])].slice(0, 30);
      state.history = [record, ...(Array.isArray(state.history) ? state.history : [])].slice(0, 80);
      sent.push(record);
      if (sent.length >= config.maxThreadsPerTick) break;
    }

    state.lastTickAt = now.toISOString();
    await writeAutopilotState(state);
    return { config, state, sent, skipped, serverTime: now.toISOString() };
  } finally {
    autopilotTickRunning = false;
  }
}

async function queryAutopilotView() {
  const [config, state, threadsPayload] = await Promise.all([
    readAutopilotConfig(),
    readAutopilotState(),
    queryThreadNudgerThreads(DEFAULT_AUTOPILOT_CONFIG.threadLimit),
  ]);
  const nowMs = Date.now();
  const threads = threadsPayload.threads.map((thread) => {
    const entry = getAutopilotThreadEntry(state, thread.id);
    return {
      id: thread.id,
      title: thread.title,
      state: thread.state,
      stateLabel: thread.stateLabel,
      lastActiveAt: thread.lastActiveAt,
      enabled: entry.enabled !== false,
      scriptId: entry.scriptId || null,
      lastSentAt: entry.lastSentAt || null,
      pausedReason: entry.pausedReason || null,
      nextActionInSeconds: Math.max(0, Math.ceil(((isoToMillis(thread.lastActiveAt || thread.updatedAt) + config.intervalMinutes * 60 * 1000) - nowMs) / 1000)),
      skipReason: autopilotThreadSkipReason(config, state, thread, nowMs),
    };
  });
  return {
    config,
    state: {
      lastTickAt: state.lastTickAt,
      updatedAt: state.updatedAt,
      history: Array.isArray(state.history) ? state.history.slice(0, 30) : [],
    },
    threads,
    serverTime: new Date().toISOString(),
  };
}

function spawnCodexRun({ mode, prompt, threadId, cwd, additionalDirs = [], metadata = {} }) {
  const runId = randomUUID();
  const run = {
    id: runId,
    threadId: threadId || null,
    cwd,
    prompt,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    output: "",
    errorOutput: "",
    usage: null,
    ...metadata,
  };
  activeRuns.set(runId, run);

  const args = mode === "resume"
    ? ["exec", "resume", "--json", "--full-auto", threadId, prompt]
    : ["exec", "--json", "--full-auto", "-C", cwd, "--skip-git-repo-check", ...additionalDirs.flatMap((dir) => ["--add-dir", dir]), prompt];

  const child = spawn(process.execPath, [CODEX_CLI_ENTRY, ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: [process.env.PATH || "", DEFAULT_EXEC_PATH]
        .filter(Boolean)
        .join(":"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const consumeLine = (rawLine, stream) => {
    const line = rawLine.toString("utf8").trim();
    if (!line) return;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "thread.started" && parsed.thread_id) {
        run.threadId = parsed.thread_id;
      } else if (parsed.type === "item.completed" && parsed.item?.type === "agent_message") {
        run.output = `${run.output}${run.output ? "\n\n" : ""}${parsed.item.text}`.trim();
      } else if (parsed.type === "turn.completed") {
        run.usage = parsed.usage || null;
      }
    } catch {
      if (stream === "stderr") {
        run.errorOutput = `${run.errorOutput}${run.errorOutput ? "\n" : ""}${line}`;
      }
    }
  };

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      consumeLine(line, "stdout");
    }
  });

  let stderrBuffer = "";
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString("utf8");
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() || "";
    for (const line of lines) {
      consumeLine(line, "stderr");
    }
  });

  child.on("close", (code) => {
    if (stdoutBuffer.trim()) consumeLine(stdoutBuffer, "stdout");
    if (stderrBuffer.trim()) consumeLine(stderrBuffer, "stderr");
    run.status = code === 0 ? "finished" : "error";
    run.finishedAt = new Date().toISOString();
    log("run.closed", run.id, `code=${code}`, `thread=${run.threadId || "pending"}`);
    activeRuns.delete(runId);
  });

  child.on("error", (error) => {
    run.status = "error";
    run.finishedAt = new Date().toISOString();
    run.errorOutput = `${run.errorOutput}${run.errorOutput ? "\n" : ""}${error.message}`;
    activeRuns.delete(runId);
  });

  return run;
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath);
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "application/javascript; charset=utf-8";
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".ttf") return "font/ttf";
  return "application/octet-stream";
}

async function serveStatic(res, relativePath) {
  const safeRelativePath = String(relativePath || "").replace(/^\/+/, "");
  const staticRoot = path.resolve(STATIC_DIR);
  const target = path.resolve(staticRoot, safeRelativePath);
  if (!target.startsWith(`${staticRoot}${path.sep}`) && target !== staticRoot) {
    throw new HttpError(403, "Forbidden");
  }
  const contents = await fs.readFile(target);
  res.writeHead(200, securityHeaders(contentTypeFor(target)));
  res.end(contents);
}

async function readAutomationHubState() {
  try {
    const raw = await fs.readFile(AUTOMATION_HUB_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(500, "Automation hub state file is invalid");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw new HttpError(500, "Automation hub state file is invalid JSON");
    }
    throw error;
  }
}

function validateAutomationHubState(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "Automation hub state must be an object");
  }

  const requiredArrayKeys = [
    "workflows",
    "libraries",
    "campaigns",
    "contentPools",
    "contentEntries",
    "momentsCampaigns",
    "momentsMaterials",
    "digest",
    "locks",
    "runtimeLogs",
    "eventLogs",
  ];

  for (const key of requiredArrayKeys) {
    if (!Array.isArray(payload[key])) {
      throw new HttpError(400, `Automation hub state is missing array: ${key}`);
    }
  }
}

async function writeAutomationHubState(payload) {
  validateAutomationHubState(payload);
  await fs.mkdir(AUTOMATION_HUB_DIR, { recursive: true });
  const serialized = JSON.stringify(payload, null, 2);
  await fs.writeFile(AUTOMATION_HUB_STATE_FILE, `${serialized}\n`, "utf8");
}

function normalizePassword(value) {
  return String(value || "").trim().toUpperCase();
}

function claimView(claim) {
  if (!claim) return null;
  const publicStage = claim.stage === "failed" ? "requested" : claim.stage;
  const publicMessage = claim.stage === "failed"
    ? "已提交申请，等待系统审批。"
    : (claim.message || "");
  return {
    sessionId: claim.sessionId,
    cardNo: claim.cardNo,
    passwordMasked: claim.passwordMasked,
    stage: publicStage,
    docTitle: claim.docTitle,
    docUrl: claim.docUrl,
    boundAt: claim.boundAt || null,
    requestedAt: claim.requestedAt || null,
    approvedAt: claim.approvedAt || null,
    expiresAt: claim.expiresAt || null,
    updatedAt: claim.updatedAt || null,
    message: publicMessage,
    approvalRun: claim.approvalRun || null,
  };
}

function usedClaimView(claim) {
  return {
    ...claimView(claim),
    stage: "used",
    message: "这个开通码已使用，不能重复开通。",
  };
}

async function ensureDocAccessDir() {
  await fs.mkdir(DOC_ACCESS_DIR, { recursive: true });
}

async function inventoryFiles() {
  await ensureDocAccessDir();
  const entries = await fs.readdir(DOC_ACCESS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => (
      entry.isFile()
      && entry.name.endsWith(".txt")
      && !entry.name.includes("delivery_urls")
      && !entry.name.includes("access_links")
    ))
    .map((entry) => path.join(DOC_ACCESS_DIR, entry.name))
    .sort();
}

async function loadDocAccessInventory() {
  const files = await inventoryFiles();
  const stats = await Promise.all(files.map(async (filePath) => {
    const stat = await fs.stat(filePath);
    return `${path.basename(filePath)}:${stat.mtimeMs}:${stat.size}`;
  }));
  const signature = stats.join("|");
  if (signature === docAccessInventoryCache.signature) {
    return docAccessInventoryCache.items;
  }

  const items = [];
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/, 2);
      const cardNo = String(parts[0] || "").trim();
      const password = String(parts[1] || parts[0] || "").trim();
      const normalizedPassword = normalizePassword(password);
      if (!cardNo || !normalizedPassword) continue;
      items.push({
        sourceFile: path.basename(filePath),
        cardNo,
        password: normalizedPassword,
        passwordMasked: `${normalizedPassword.slice(0, 4)}****${normalizedPassword.slice(-4)}`,
      });
    }
  }

  docAccessInventoryCache = { signature, items };
  return items;
}

async function loadDocAccessClaims() {
  await ensureDocAccessDir();
  try {
    const raw = await fs.readFile(DOC_ACCESS_CLAIMS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function saveDocAccessClaims(claims) {
  await ensureDocAccessDir();
  const tempPath = `${DOC_ACCESS_CLAIMS_FILE}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(claims, null, 2), "utf8");
  await fs.rename(tempPath, DOC_ACCESS_CLAIMS_FILE);
}

function cleanupDocAccessClaims(claims, now = Date.now()) {
  let changed = false;
  for (const claim of Object.values(claims)) {
    if (!claim || !claim.expiresAt) continue;
    if (["bound", "requested"].includes(claim.stage) && new Date(claim.expiresAt).getTime() <= now) {
      claim.stage = "expired";
      claim.updatedAt = new Date(now).toISOString();
      claim.message = "开通窗口已过期，请重新打开发货链接。";
      changed = true;
    }
  }
  return changed;
}

function findClaimByPassword(claims, password) {
  return Object.values(claims).find((claim) => claim.password === password) || null;
}

function activeClaim(claims, now = Date.now()) {
  return Object.values(claims).find((claim) => {
    if (!claim || !["bound", "requested"].includes(claim.stage) || !claim.expiresAt) return false;
    return new Date(claim.expiresAt).getTime() > now;
  }) || null;
}

async function verifyDocAccessPassword(password) {
  const normalizedPassword = normalizePassword(password);
  if (!normalizedPassword) {
    throw new HttpError(400, "请输入开通码");
  }

  const [inventory, claims] = await Promise.all([
    loadDocAccessInventory(),
    loadDocAccessClaims(),
  ]);

  const cleaned = cleanupDocAccessClaims(claims);
  const item = inventory.find((entry) => entry.password === normalizedPassword);
  if (!item) {
    if (cleaned) await saveDocAccessClaims(claims);
    throw new HttpError(404, "开通码无效");
  }

  const existing = findClaimByPassword(claims, normalizedPassword);
  if (existing && existing.stage === "approved") {
    if (cleaned) await saveDocAccessClaims(claims);
    return usedClaimView(existing);
  }

  if (existing && ["bound", "requested"].includes(existing.stage) && existing.expiresAt && new Date(existing.expiresAt).getTime() > Date.now()) {
    if (cleaned) await saveDocAccessClaims(claims);
    return claimView(existing);
  }

  const busy = activeClaim(claims);
  if (busy) {
    if (cleaned) await saveDocAccessClaims(claims);
    throw new HttpError(409, "当前开通通道正忙，请稍后再试");
  }

  const now = new Date();
  const claim = {
    sessionId: randomUUID(),
    cardNo: item.cardNo,
    password: item.password,
    passwordMasked: item.passwordMasked,
    stage: "bound",
    docTitle: DOC_ACCESS_DOC_TITLE,
    docUrl: DOC_ACCESS_DOC_URL,
    boundAt: now.toISOString(),
    requestedAt: null,
    approvedAt: null,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DOC_ACCESS_BIND_WINDOW_MS).toISOString(),
    message: "点击“去飞书提交申请”进入飞书，在申请备注里粘贴咸鱼发来的开通码。",
    approvalRun: null,
  };
  claims[claim.sessionId] = claim;
  await saveDocAccessClaims(claims);
  return claimView(claim);
}

async function readWorkerState() {
  try {
    const raw = await fs.readFile(path.join(WORK_CENTER_ROOT, "state", "feishu_auto", "approval_worker_state.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function spawnDocAccessApproval(sessionId, noteToken) {
  if (activeDocAccessRun && activeDocAccessRun.status === "running") {
    throw new HttpError(409, "已有审批任务正在运行");
  }

  if (!String(noteToken || "").trim()) {
    throw new HttpError(500, "开通码缺失，无法校验申请备注");
  }

  const child = spawn(
    DOC_ACCESS_WORKER,
    ["approve", DOC_ACCESS_DOC_TITLE, String(DOC_ACCESS_APPROVE_TIMEOUT_SECONDS), String(noteToken).trim()],
    {
    cwd: WORK_CENTER_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const run = {
    sessionId,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stdout: "",
    stderr: "",
  };
  activeDocAccessRun = run;

  child.stdout.on("data", (chunk) => {
    run.stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    run.stderr += chunk.toString("utf8");
  });

  child.on("close", async (code) => {
    run.status = code === 0 ? "finished" : "error";
    run.finishedAt = new Date().toISOString();
    try {
      const claims = await loadDocAccessClaims();
      const claim = claims[sessionId];
      if (!claim) {
        activeDocAccessRun = null;
        return;
      }

      const workerState = await readWorkerState();
      claim.updatedAt = new Date().toISOString();
      if (code === 0 && workerState?.success) {
        claim.stage = "approved";
        claim.approvedAt = new Date().toISOString();
        claim.message = "阅读权限已开通。";
      } else {
        claim.stage = "timeout";
        claim.message = "暂时没有匹配到带开通码的待审批申请。请确认你已在飞书提交申请，并把开通码粘贴到备注里。";
      }
      claim.approvalRun = {
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        status: run.status,
        exitCode: code,
      };
      await saveDocAccessClaims(claims);
    } catch (error) {
      log("doc-access.run.error", error.stack || error.message);
    } finally {
      activeDocAccessRun = null;
    }
  });

  child.on("error", async (error) => {
    run.status = "error";
    run.finishedAt = new Date().toISOString();
    run.stderr = `${run.stderr}${run.stderr ? "\n" : ""}${error.message}`;
    try {
      const claims = await loadDocAccessClaims();
      const claim = claims[sessionId];
      if (claim) {
        claim.stage = "requested";
        claim.updatedAt = new Date().toISOString();
        claim.message = "已提交申请，等待系统审批。";
        claim.approvalRun = {
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          status: run.status,
          error: error.message,
        };
        await saveDocAccessClaims(claims);
      }
    } catch (nestedError) {
      log("doc-access.run.error", nestedError.stack || nestedError.message);
    } finally {
      activeDocAccessRun = null;
    }
  });

  return run;
}

async function markDocAccessRequested(sessionId) {
  const claims = await loadDocAccessClaims();
  const cleaned = cleanupDocAccessClaims(claims);
  const claim = claims[sessionId];
  if (!claim) {
    if (cleaned) await saveDocAccessClaims(claims);
    throw new HttpError(404, "开通会话不存在");
  }
  if (claim.stage === "approved") {
    if (cleaned) await saveDocAccessClaims(claims);
    return claimView(claim);
  }
  if (claim.stage === "expired") {
    if (cleaned) await saveDocAccessClaims(claims);
    throw new HttpError(409, "开通窗口已过期，请重新打开发货链接");
  }
  claim.stage = "requested";
  claim.requestedAt = claim.requestedAt || new Date().toISOString();
  claim.updatedAt = new Date().toISOString();
  claim.expiresAt = new Date(Date.now() + (DOC_ACCESS_APPROVE_TIMEOUT_SECONDS + 30) * 1000).toISOString();
  claim.message = "本地审批正在处理中。系统只会通过备注里带开通码的申请。";
  if (activeDocAccessRun?.sessionId === sessionId && activeDocAccessRun.status === "running") {
    claim.approvalRun = {
      startedAt: activeDocAccessRun.startedAt,
      finishedAt: activeDocAccessRun.finishedAt,
      status: activeDocAccessRun.status,
    };
    await saveDocAccessClaims(claims);
    return claimView(claim);
  }

  const run = spawnDocAccessApproval(sessionId, claim.password || claim.cardNo);
  claim.approvalRun = {
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
  };
  await saveDocAccessClaims(claims);
  return claimView(claim);
}

async function getDocAccessSession(sessionId) {
  const claims = await loadDocAccessClaims();
  const cleaned = cleanupDocAccessClaims(claims);
  const claim = claims[sessionId];
  if (cleaned) {
    await saveDocAccessClaims(claims);
  }
  if (!claim) {
    throw new HttpError(404, "开通会话不存在");
  }
  if (activeDocAccessRun?.sessionId === sessionId && activeDocAccessRun.status === "running") {
    claim.approvalRun = {
      startedAt: activeDocAccessRun.startedAt,
      finishedAt: activeDocAccessRun.finishedAt,
      status: activeDocAccessRun.status,
    };
  }
  return claimView(claim);
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    assertAuthorized(req, requestUrl);

    if (!["GET", "POST", "PUT", "OPTIONS"].includes(req.method || "")) {
      sendJson(res, 405, { error: "Method not allowed" }, { allow: "GET, POST, PUT, OPTIONS" });
      return;
    }

    if (req.method === "OPTIONS" && requestUrl.pathname.startsWith("/api/doc-access/")) {
      sendText(res, 204, "", "text/plain; charset=utf-8", {
        allow: "GET, POST, OPTIONS",
        ...docAccessCorsHeaders(req),
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/") {
      await serveStatic(res, "index.html");
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/thread-chat") {
      await serveStatic(res, "thread-chat.html");
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/app.js") {
      await serveStatic(res, "app.js");
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/thread-chat.js") {
      await serveStatic(res, "thread-chat.js");
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/styles.css") {
      await serveStatic(res, "styles.css");
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/thread-chat.css") {
      await serveStatic(res, "thread-chat.css");
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/favicon.svg") {
      await serveStatic(res, "favicon.svg");
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/favicon.ico") {
      res.writeHead(204, securityHeaders("image/x-icon"));
      res.end();
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/automation-hub") {
      await serveStatic(res, "automation-hub-prototype.html");
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/automation-hub-prototype.css") {
      await serveStatic(res, "automation-hub-prototype.css");
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/automation-hub-prototype.js") {
      await serveStatic(res, "automation-hub-prototype.js");
      return;
    }

    if (req.method === "GET" && requestUrl.pathname.startsWith("/assets/")) {
      await serveStatic(res, decodeURIComponent(requestUrl.pathname.slice(1)));
      return;
    }

    if (req.method === "GET" && (requestUrl.pathname === "/doc-access-demo" || requestUrl.pathname === "/open/doc-access")) {
      await serveStatic(res, "doc-access-demo.html");
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/doc-access-demo.css") {
      await serveStatic(res, "doc-access-demo.css");
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/doc-access-demo.js") {
      await serveStatic(res, "doc-access-demo.js");
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/doc-access-note-example.svg") {
      await serveStatic(res, "doc-access-note-example.svg");
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/doc-access-note-original.png") {
      await serveStatic(res, "doc-access-note-original.png");
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/doc-access/verify") {
      assertSameOrigin(req);
      assertJsonRequest(req);
      const body = await readJsonBody(req);
      const session = await verifyDocAccessPassword(body.password);
      sendJson(res, 200, { session }, docAccessCorsHeaders(req));
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/automation-hub/state") {
      const state = await readAutomationHubState();
      if (!state) {
        sendJson(res, 200, { state: null, initialized: false });
        return;
      }
      const stats = await fs.stat(AUTOMATION_HUB_STATE_FILE);
      sendJson(res, 200, {
        state,
        initialized: true,
        savedAt: stats.mtime.toISOString(),
        file: path.relative(WORK_CENTER_ROOT, AUTOMATION_HUB_STATE_FILE),
      });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/automation-hub/state") {
      assertSameOrigin(req);
      assertJsonRequest(req);
      const body = await readJsonBody(req);
      const nextState = body?.state && typeof body.state === "object" ? body.state : body;
      await writeAutomationHubState(nextState);
      sendJson(res, 200, {
        ok: true,
        state: nextState,
        savedAt: new Date().toISOString(),
        file: path.relative(WORK_CENTER_ROOT, AUTOMATION_HUB_STATE_FILE),
      });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname.startsWith("/api/doc-access/sessions/") && requestUrl.pathname.endsWith("/requested")) {
      assertSameOrigin(req);
      assertJsonRequest(req);
      await readJsonBody(req);
      const sessionId = decodeURIComponent(requestUrl.pathname.replace("/api/doc-access/sessions/", "").replace("/requested", ""));
      const session = await markDocAccessRequested(sessionId);
      sendJson(res, 200, { session }, docAccessCorsHeaders(req));
      return;
    }

    if (req.method === "GET" && requestUrl.pathname.startsWith("/api/doc-access/sessions/")) {
      const sessionId = decodeURIComponent(requestUrl.pathname.replace("/api/doc-access/sessions/", ""));
      const session = await getDocAccessSession(sessionId);
      sendJson(res, 200, { session }, docAccessCorsHeaders(req));
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/weekly-plans") {
      const payload = await queryWeeklyPlans();
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/chat-ui/session") {
      const session = getThreadChatSession(req);
      sendJson(res, 200, session ? threadChatSessionPayload(session) : { authenticated: false });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/chat-ui/login") {
      assertSameOrigin(req);
      assertJsonRequest(req);
      const body = await readJsonBody(req);
      const password = String(body.password || "");
      const config = await loadThreadChatAuthConfig();
      const derivedHash = deriveThreadChatPasswordHash(password, config);
      if (!hexEquals(derivedHash, config.passwordHash)) {
        throw new HttpError(401, "Password is incorrect");
      }
      const session = await createThreadChatSession();
      sendJson(
        res,
        200,
        threadChatSessionPayload(session),
        {
          "set-cookie": buildSetCookie(
            THREAD_CHAT_SESSION_COOKIE,
            session.id,
            threadChatCookieOptions(req),
          ),
        },
      );
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/chat-ui/logout") {
      assertSameOrigin(req);
      assertJsonRequest(req);
      const session = getThreadChatSession(req);
      if (session) {
        threadChatSessions.delete(session.id);
      }
      sendJson(
        res,
        200,
        { ok: true },
        {
          "set-cookie": buildSetCookie(
            THREAD_CHAT_SESSION_COOKIE,
            "",
            {
              ...threadChatCookieOptions(req, 0),
              expires: new Date(0),
            },
          ),
        },
      );
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/chat-ui/autopilot") {
      getThreadChatSession(req, { required: true });
      const payload = await queryAutopilotView();
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "PUT" && requestUrl.pathname === "/api/chat-ui/autopilot") {
      assertSameOrigin(req);
      assertJsonRequest(req);
      const session = getThreadChatSession(req, { required: true });
      assertThreadChatCsrf(req, session);
      const body = await readJsonBody(req);
      const config = await writeAutopilotConfig(body?.config && typeof body.config === "object" ? body.config : body);
      const payload = await queryAutopilotView();
      sendJson(res, 200, { ...payload, config });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/chat-ui/autopilot/tick") {
      assertSameOrigin(req);
      assertJsonRequest(req);
      const session = getThreadChatSession(req, { required: true });
      assertThreadChatCsrf(req, session);
      await readJsonBody(req);
      const result = await runAutopilotTick();
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/chat-ui/threads") {
      getThreadChatSession(req, { required: true });
      const payload = await queryThreadChatThreads(Number(requestUrl.searchParams.get("limit") || MAX_THREAD_LIST));
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "GET" && requestUrl.pathname.startsWith("/api/chat-ui/threads/")) {
      getThreadChatSession(req, { required: true });
      const threadId = requestUrl.pathname.replace("/api/chat-ui/threads/", "");
      const payload = await queryThreadChatThread(threadId);
      if (!payload) {
        sendJson(res, 404, { error: "Thread not found" });
        return;
      }
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname.startsWith("/api/chat-ui/threads/") && requestUrl.pathname.endsWith("/messages")) {
      assertSameOrigin(req);
      assertJsonRequest(req);
      const session = getThreadChatSession(req, { required: true });
      assertThreadChatCsrf(req, session);

      const threadId = requestUrl.pathname.replace("/api/chat-ui/threads/", "").replace("/messages", "");
      const thread = await queryThread(threadId);
      if (!thread) {
        sendJson(res, 404, { error: "Thread not found" });
        return;
      }

      const existingRun = [...activeRuns.values()].find((run) => run.threadId === threadId && run.status === "running");
      if (existingRun) {
        sendJson(res, 409, { error: "This thread already has a running task", run: existingRun });
        return;
      }

      const body = await readJsonBody(req);
      const prompt = String(body.message || "").trim();
      if (!prompt) {
        sendJson(res, 400, { error: "Message is required" });
        return;
      }

      const run = spawnCodexRun({ mode: "resume", threadId, prompt, cwd: thread.cwd });
      sendJson(res, 202, { run });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/thread-creatures") {
      const payload = await queryThreadCreatures(Number(requestUrl.searchParams.get("limit") || THREAD_CREATURE_LIMIT));
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/nudger/threads") {
      const payload = await queryThreadNudgerThreads(Number(requestUrl.searchParams.get("limit") || MAX_THREAD_LIST));
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname.startsWith("/api/weekly-plans/") && requestUrl.pathname.endsWith("/trigger")) {
      assertSameOrigin(req);
      assertJsonRequest(req);
      await readJsonBody(req);

      const planId = decodeURIComponent(
        requestUrl.pathname.replace("/api/weekly-plans/", "").replace("/trigger", ""),
      );
      const { plans } = await queryWeeklyPlans();
      const plan = plans.find((item) => item.id === planId);

      if (!plan) {
        sendJson(res, 404, { error: "Weekly plan not found" });
        return;
      }

      if (!String(plan.prompt || "").trim()) {
        sendJson(res, 400, { error: "This weekly plan does not have a runnable prompt" });
        return;
      }

      const existingRun = [...activeRuns.values()].find((run) => run.planId === planId && run.status === "running");
      if (existingRun) {
        sendJson(res, 409, { error: "This weekly plan is already running", run: existingRun });
        return;
      }

      const run = spawnCodexRun({
        mode: "new",
        prompt: plan.prompt,
        cwd: plan.primaryCwd || DEFAULT_CWD,
        additionalDirs: plan.extraCwds || [],
        metadata: {
          planId,
          planKind: plan.kind,
          planName: plan.name,
        },
      });

      sendJson(res, 202, { run });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/threads") {
      const threads = await queryThreads(Number(requestUrl.searchParams.get("limit") || MAX_THREAD_LIST));
      sendJson(res, 200, { threads });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname.startsWith("/api/threads/")) {
      const threadId = requestUrl.pathname.replace("/api/threads/", "");
      const thread = await queryThread(threadId);
      if (!thread) {
        sendJson(res, 404, { error: "Thread not found" });
        return;
      }
      const session = await parseSessionFile(thread.rollout_path, true);
      const activeRun = [...activeRuns.values()].find((run) => run.threadId === threadId && run.status === "running") || null;
      sendJson(res, 200, {
        thread: {
          id: thread.id,
          title: thread.title,
          updatedAt: unixSecondsToIso(thread.updated_at),
        },
        session,
        activeRun,
      });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/threads") {
      assertSameOrigin(req);
      assertJsonRequest(req);
      const body = await readJsonBody(req);
      const prompt = String(body.prompt || "").trim();
      const cwd = String(body.cwd || DEFAULT_CWD).trim() || DEFAULT_CWD;
      if (!prompt) {
        sendJson(res, 400, { error: "Prompt is required" });
        return;
      }
      const run = spawnCodexRun({ mode: "new", prompt, cwd });
      sendJson(res, 202, { run });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname.endsWith("/messages")) {
      assertSameOrigin(req);
      assertJsonRequest(req);
      const threadId = requestUrl.pathname.replace("/api/threads/", "").replace("/messages", "");
      const thread = await queryThread(threadId);
      if (!thread) {
        sendJson(res, 404, { error: "Thread not found" });
        return;
      }
      const existingRun = [...activeRuns.values()].find((run) => run.threadId === threadId && run.status === "running");
      if (existingRun) {
        sendJson(res, 409, { error: "This thread already has a running task", run: existingRun });
        return;
      }
      const body = await readJsonBody(req);
      const prompt = String(body.message || "").trim();
      if (!prompt) {
        sendJson(res, 400, { error: "Message is required" });
        return;
      }
      const run = spawnCodexRun({ mode: "resume", threadId, prompt, cwd: thread.cwd });
      sendJson(res, 202, { run });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/healthz") {
      sendText(res, 200, "ok");
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    log("request.error", error.stack || error.message);
    if (error instanceof HttpError) {
      const docAccessHeaders = requestUrl.pathname.startsWith("/api/doc-access/")
        ? docAccessCorsHeaders(req)
        : {};
      sendJson(res, error.statusCode, { error: error.message }, { ...error.headers, ...docAccessHeaders });
      return;
    }
    const docAccessHeaders = requestUrl.pathname.startsWith("/api/doc-access/")
      ? docAccessCorsHeaders(req)
      : {};
    sendJson(res, 500, {
      error: "Internal server error",
    }, docAccessHeaders);
  }
});

server.listen(PORT, HOST, () => {
  log(`codex-remote-hub listening on http://${HOST}:${PORT}`);
});

setInterval(() => {
  runAutopilotTick().catch((error) => {
    log("autopilot.error", error.stack || error.message);
  });
}, AUTOPILOT_TICK_MS);
