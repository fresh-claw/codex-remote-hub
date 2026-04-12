#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORK_CENTER_ROOT = __dirname;
const DEFAULT_CONFIG_PATH = process.env.MATRIX_BRIDGE_CONFIG
  || path.join(WORK_CENTER_ROOT, "config", "matrix_bridge.json");
const DEFAULT_STATE_DIR = path.join(WORK_CENTER_ROOT, "state", "matrix_bridge");
const DEFAULT_STATE_PATH = path.join(DEFAULT_STATE_DIR, "bridge_state.json");
const DEFAULT_CONSOLE_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_STATUS_POLL_MS = 10 * 1000;
const DEFAULT_SYNC_TIMEOUT_MS = 30 * 1000;
const DEFAULT_THREAD_LIMIT = 12;
const DEFAULT_MESSAGE_BACKFILL_LIMIT = 12;
const DEFAULT_ROOM_CREATE_PER_SWEEP = 1;
const DEFAULT_ROOM_CLEANUP_SCAN_LIMIT = 80;
const DEFAULT_RECENT_SIGNATURE_LIMIT = 40;

function log(...parts) {
  console.log(new Date().toISOString(), "[matrix-bridge]", ...parts);
}

function trimText(value, max = 180) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function simplifyForChat(value) {
  return String(value || "")
    .replace(/\/Users\/[^\s`"'）)]+/g, "[本地路径]")
    .replace(/`\/Users\/[^`]+`/g, "`[本地路径]`")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
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

function requestJson(url, { method, headers, body, timeoutMs }) {
  const target = url instanceof URL ? url : new URL(String(url));
  const transport = target.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method,
      headers,
      family: 4,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let payload = {};
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          payload = { raw };
        }

        if ((response.statusCode || 500) >= 400) {
          const message = payload.error
            || payload.errcode
            || `HTTP ${response.statusCode || 500}`;
          reject(new Error(message));
          return;
        }
        resolve(payload);
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    request.on("error", reject);

    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

async function curlJson(url, { method, headers, body, timeoutMs }) {
  const separator = "__CODEX_CURL_STATUS__:";
  const args = [
    "--ipv4",
    "-sS",
    "-X", method,
    "-w", `\n${separator}%{http_code}`,
  ];

  for (const [key, value] of Object.entries(headers || {})) {
    args.push("-H", `${key}: ${value}`);
  }

  if (body !== undefined) {
    args.push("--data", body);
  }

  if (timeoutMs) {
    args.push("--max-time", String(Math.max(5, Math.ceil(timeoutMs / 1000))));
  }

  args.push(url.toString());

  const { stdout, stderr } = await execFileAsync("/usr/bin/curl", args, {
    maxBuffer: 2 * 1024 * 1024,
  });

  const markerIndex = stdout.lastIndexOf(separator);
  if (markerIndex === -1) {
    throw new Error(stderr.trim() || "curl response missing status marker");
  }

  const rawBody = stdout.slice(0, markerIndex).trim();
  const statusCode = Number(stdout.slice(markerIndex + separator.length).trim());

  let payload = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    payload = { raw: rawBody };
  }

  if (statusCode >= 400) {
    throw new Error(payload.error || payload.errcode || `HTTP ${statusCode}`);
  }

  return payload;
}

function printHelp() {
  console.log(`
Matrix bridge for Codex Dispatch.

Usage:
  node matrix_bridge.mjs [--config ./config/matrix_bridge.json] [--once]

Required config:
  homeserverUrl
  userId
  dispatchRoomId
  accessToken or password

Optional config:
  password
  allowedUserIds
  inviteUserIds
  codexConsoleBaseUrl
  codexBridgeToken
  defaultCwd
  stateDir
  syncTimeoutMs
  statusPollMs

Supported room commands:
  !codex help
  !codex status
  !codex threads
  !codex rooms
  !codex bind <thread-ref>
  !codex unbind
  !codex who
  !codex say <thread-ref> :: <message>
  !codex new [cwd] :: <prompt>
  !codex room <thread-ref>

In a room already bound to a thread:
  Any plain-text message from an allowed user is forwarded to that Codex thread.
`.trim());
}

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    once: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--once") {
      options.once = true;
      continue;
    }
    if (token === "--config") {
      options.configPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function envArray(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function loadConfig(configPath) {
  const fromFile = await readJsonFile(configPath, {});
  const stateDir = process.env.MATRIX_BRIDGE_STATE_DIR
    || fromFile.stateDir
    || DEFAULT_STATE_DIR;

  return {
    configPath,
    homeserverUrl: process.env.MATRIX_HOMESERVER_URL || fromFile.homeserverUrl || "",
    matrixWriteUrl: process.env.MATRIX_WRITE_URL || fromFile.matrixWriteUrl || process.env.MATRIX_HOMESERVER_URL || fromFile.homeserverUrl || "",
    accessToken: process.env.MATRIX_ACCESS_TOKEN || fromFile.accessToken || "",
    password: process.env.MATRIX_PASSWORD || fromFile.password || "",
    userId: process.env.MATRIX_USER_ID || fromFile.userId || "",
    dispatchRoomId: process.env.MATRIX_DISPATCH_ROOM_ID || fromFile.dispatchRoomId || "",
    allowedUserIds: envArray("MATRIX_ALLOWED_USER_IDS").length
      ? envArray("MATRIX_ALLOWED_USER_IDS")
      : Array.isArray(fromFile.allowedUserIds) ? fromFile.allowedUserIds : [],
    inviteUserIds: envArray("MATRIX_INVITE_USER_IDS").length
      ? envArray("MATRIX_INVITE_USER_IDS")
      : Array.isArray(fromFile.inviteUserIds) ? fromFile.inviteUserIds : [],
    codexConsoleBaseUrl: process.env.CODEX_CONSOLE_BASE_URL || fromFile.codexConsoleBaseUrl || DEFAULT_CONSOLE_BASE_URL,
    codexBridgeToken: process.env.CODEX_BRIDGE_TOKEN || fromFile.codexBridgeToken || "",
    defaultCwd: process.env.MATRIX_DEFAULT_CWD || fromFile.defaultCwd || process.cwd(),
    stateDir,
    statePath: process.env.MATRIX_BRIDGE_STATE_PATH || fromFile.statePath || path.join(stateDir, "bridge_state.json"),
    syncTimeoutMs: Number(process.env.MATRIX_SYNC_TIMEOUT_MS || fromFile.syncTimeoutMs || DEFAULT_SYNC_TIMEOUT_MS),
    statusPollMs: Number(process.env.MATRIX_STATUS_POLL_MS || fromFile.statusPollMs || DEFAULT_STATUS_POLL_MS),
    threadListLimit: Number(process.env.MATRIX_THREAD_LIST_LIMIT || fromFile.threadListLimit || DEFAULT_THREAD_LIMIT),
  };
}

function validateConfig(config) {
  const missing = [];
  if (!config.homeserverUrl) missing.push("homeserverUrl");
  if (!config.userId) missing.push("userId");
  if (!config.dispatchRoomId) missing.push("dispatchRoomId");

  if (missing.length) {
    throw new Error(`Missing required Matrix bridge config: ${missing.join(", ")}.`);
  }

  if (!/^https?:\/\//i.test(config.homeserverUrl)) {
    throw new Error("homeserverUrl must be an absolute http(s) URL.");
  }

  if (!/^https?:\/\//i.test(config.matrixWriteUrl)) {
    throw new Error("matrixWriteUrl must be an absolute http(s) URL.");
  }

  if (!/^https?:\/\//i.test(config.codexConsoleBaseUrl)) {
    throw new Error("codexConsoleBaseUrl must be an absolute http(s) URL.");
  }

  if (!Array.isArray(config.allowedUserIds) || !config.allowedUserIds.length) {
    throw new Error("allowedUserIds must contain at least one Matrix user ID.");
  }

  if (!config.accessToken && !config.password) {
    throw new Error("Either accessToken or password must be provided for the Matrix bot account.");
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function normalizeRoomBinding(input = {}) {
  if (!input || typeof input !== "object") {
    return {};
  }
  return {
    threadId: String(input.threadId || "").trim(),
    threadTitle: String(input.threadTitle || "").trim(),
    threadCwd: String(input.threadCwd || "").trim(),
    boundAt: String(input.boundAt || "").trim(),
    boundBy: String(input.boundBy || "").trim(),
  };
}

function normalizeRoomMessageCursor(input = {}) {
  if (!input || typeof input !== "object") {
    return {};
  }
  return {
    threadId: String(input.threadId || "").trim(),
    count: Number(input.count || 0),
    lastMessageAt: String(input.lastMessageAt || "").trim(),
    recentSignatures: Array.isArray(input.recentSignatures)
      ? input.recentSignatures.map((item) => String(item || "").trim()).filter(Boolean).slice(-DEFAULT_RECENT_SIGNATURE_LIMIT)
      : [],
  };
}

class MatrixBridge {
  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
    this.state = {
      sinceToken: null,
      roomBindings: {},
      roomStatusDigest: {},
      roomMessageCursor: {},
      roomCleanupDone: {},
    };
    this.running = false;
    this.statusTimer = null;
    this.pendingUserEcho = {};
  }

  async init() {
    await ensureDir(this.config.stateDir);
    const stored = await readJsonFile(this.config.statePath, {});
    this.state.sinceToken = typeof stored.sinceToken === "string" ? stored.sinceToken : null;
    const bindings = stored.roomBindings && typeof stored.roomBindings === "object" ? stored.roomBindings : {};
    for (const [roomId, binding] of Object.entries(bindings)) {
      const normalized = normalizeRoomBinding(binding);
      if (!normalized.threadId) continue;
      this.state.roomBindings[roomId] = normalized;
    }
    this.state.roomStatusDigest = stored.roomStatusDigest && typeof stored.roomStatusDigest === "object"
      ? stored.roomStatusDigest
      : {};
    this.state.roomMessageCursor = stored.roomMessageCursor && typeof stored.roomMessageCursor === "object"
      ? stored.roomMessageCursor
      : {};
    for (const [roomId, cursor] of Object.entries(this.state.roomMessageCursor)) {
      this.state.roomMessageCursor[roomId] = normalizeRoomMessageCursor(cursor);
    }
    this.state.roomCleanupDone = stored.roomCleanupDone && typeof stored.roomCleanupDone === "object"
      ? stored.roomCleanupDone
      : {};

    log("init", `config=${this.config.configPath}`, `state=${this.config.statePath}`);
    await this.ensureMatrixAuth();
  }

  async saveState() {
    const payload = {
      sinceToken: this.state.sinceToken,
      roomBindings: this.state.roomBindings,
      roomStatusDigest: this.state.roomStatusDigest,
      roomMessageCursor: this.state.roomMessageCursor,
      roomCleanupDone: this.state.roomCleanupDone,
      savedAt: new Date().toISOString(),
    };
    await fs.writeFile(this.config.statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  async matrixRequest(method, pathname, { body, query } = {}) {
    const baseUrl = this.config.homeserverUrl;
    const url = new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }

    const headers = {
      "content-type": "application/json",
    };
    if (this.config.accessToken) {
      headers.Authorization = `Bearer ${this.config.accessToken}`;
    }

    try {
      return await curlJson(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs: pathname.includes("/sync")
          ? Math.max(90_000, this.config.syncTimeoutMs + 90_000)
          : Math.max(15_000, this.config.syncTimeoutMs + 15_000),
      });
    } catch (error) {
      throw new Error(`Matrix ${method} ${pathname} failed: ${error.message}`.trim());
    }
  }

  async matrixWriteRequest(method, pathname, { body, query } = {}) {
    const baseUrl = this.config.matrixWriteUrl || this.config.homeserverUrl;
    const url = new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }

    const headers = {
      "content-type": "application/json",
    };
    if (this.config.accessToken) {
      headers.Authorization = `Bearer ${this.config.accessToken}`;
    }

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await curlJson(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          timeoutMs: 45_000,
        });
      } catch (error) {
        lastError = error;
        await sleep(1_500);
      }
    }

    throw new Error(`Matrix ${method} ${pathname} failed: ${lastError?.message || "unknown error"}`.trim());
  }

  async ensureMatrixAuth() {
    if (this.config.accessToken) {
      return;
    }

    const loginName = this.config.userId.startsWith("@")
      ? this.config.userId.slice(1).split(":")[0]
      : this.config.userId;

    const payload = await this.matrixRequest("POST", "/_matrix/client/v3/login", {
      body: {
        type: "m.login.password",
        identifier: {
          type: "m.id.user",
          user: loginName,
        },
        password: this.config.password,
        initial_device_display_name: "Codex Matrix Bridge",
      },
    });

    if (!payload.access_token) {
      throw new Error("Matrix password login succeeded but no access_token was returned.");
    }

    this.config.accessToken = payload.access_token;
    if (payload.user_id) {
      this.config.userId = payload.user_id;
    }
    log("auth.ok", this.config.userId);
  }

  async codexRequest(method, pathname, body) {
    const url = new URL(pathname, this.config.codexConsoleBaseUrl.endsWith("/") ? this.config.codexConsoleBaseUrl : `${this.config.codexConsoleBaseUrl}/`);
    const headers = {
      "content-type": "application/json",
    };
    if (this.config.codexBridgeToken) {
      headers["x-codex-bridge-token"] = this.config.codexBridgeToken;
    }
    try {
      return await requestJson(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs: 60_000,
      });
    } catch (error) {
      throw new Error(`Codex API ${method} ${pathname} failed: ${error.message}`);
    }
  }

  async sendNotice(roomId, message) {
    await this.matrixWriteRequest("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(randomUUID())}`, {
      body: {
        msgtype: "m.notice",
        body: trimText(message, 20_000),
      },
    });
  }

  async sendText(roomId, message) {
    await this.matrixWriteRequest("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(randomUUID())}`, {
      body: {
        msgtype: "m.text",
        body: trimText(message, 20_000),
      },
    });
  }

  async redactEvent(roomId, eventId, reason = "cleanup") {
    await this.matrixWriteRequest("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(randomUUID())}`, {
      body: { reason },
    });
  }

  getRoomIdForThread(threadId) {
    for (const [roomId, binding] of Object.entries(this.state.roomBindings)) {
      if (binding.threadId === threadId) {
        return roomId;
      }
    }
    return null;
  }

  async createPrivateRoomForThread(thread, sender) {
    const roomName = `Codex • ${trimText(thread.title || thread.id, 42)}`;
    const topic = `Codex thread ${thread.id}\nCWD: ${thread.cwd || this.config.defaultCwd}`;
    const invite = [...new Set(this.config.inviteUserIds.length ? this.config.inviteUserIds : this.config.allowedUserIds)]
      .filter((userId) => userId && userId !== this.config.userId);

    const created = await this.matrixWriteRequest("POST", "/_matrix/client/v3/createRoom", {
      body: {
        name: roomName,
        topic,
        preset: "private_chat",
        is_direct: false,
        invite,
      },
    });

    this.state.roomBindings[created.room_id] = {
      threadId: thread.id,
      threadTitle: thread.title,
      threadCwd: thread.cwd || "",
      boundAt: new Date().toISOString(),
      boundBy: sender,
    };
    delete this.state.roomMessageCursor[created.room_id];
    await this.saveState();

    await this.sendNotice(created.room_id, [
      `已绑定到线程 ${thread.id}`,
      `${thread.title || "未命名线程"}`,
      "",
      "直接发文字就会转发给这个线程。",
      "可用命令：",
      "!codex status",
      "!codex who",
      "!codex unbind",
    ].join("\n"));

    return created.room_id;
  }

  async ensureRoomForThread(thread, { sender = this.config.userId, announce = false } = {}) {
    const existingRoomId = this.getRoomIdForThread(thread.id);
    if (existingRoomId) {
      return existingRoomId;
    }

    const roomId = await this.createPrivateRoomForThread(thread, sender);
    if (announce) {
      await this.sendNotice(this.config.dispatchRoomId, [
        "已为本机新线程创建房间",
        `- 标题: ${thread.title || thread.id}`,
        `- 房间: ${roomId}`,
        "",
        "去 Element 邀请列表接受即可开始远程操作。",
      ].join("\n"));
    }
    return roomId;
  }

  async getThreadCreatures() {
    const payload = await this.codexRequest("GET", "/api/thread-creatures");
    return Array.isArray(payload.threads) ? payload.threads : [];
  }

  async getThreads() {
    const payload = await this.codexRequest("GET", "/api/threads");
    return Array.isArray(payload.threads) ? payload.threads : [];
  }

  async getThread(threadId) {
    return this.codexRequest("GET", `/api/threads/${encodeURIComponent(threadId)}`);
  }

  async resumeThread(threadId, message) {
    return this.codexRequest("POST", `/api/threads/${encodeURIComponent(threadId)}/messages`, { message });
  }

  async createThread(prompt, cwd) {
    return this.codexRequest("POST", "/api/threads", { prompt, cwd });
  }

  formatCreatureLine(creature, index) {
    const meta = creature.state === "dead"
      ? `${creature.staleMinutes}m`
      : creature.state === "running"
        ? "running"
        : "waiting";
    return `${String(index + 1).padStart(2, " ")}. [${creature.state}] ${trimText(creature.title || creature.id, 72)} (${meta})`;
  }

  buildStatusDigest(creature) {
    return creature
      ? [
          creature.state,
          creature.updatedAt || "",
          creature.lastActiveAt || "",
          creature.activeRun?.id || "",
          creature.preview || "",
        ].join("|")
      : "missing";
  }

  formatThreadStatus(creature, binding) {
    if (!creature) {
      return [
        "线程状态更新",
        `- 绑定线程不存在: ${binding.threadId}`,
      ].join("\n");
    }

    const lines = [
      `线程状态更新`,
      `- 标题: ${creature.title}`,
      `- 状态: ${creature.stateLabel}`,
      `- 提示: ${creature.stateHint}`,
      `- 目录: ${creature.cwd}`,
    ];

    if (creature.preview) {
      lines.push(`- 最近内容: ${trimText(creature.preview, 140)}`);
    }
    if (creature.lastActiveAt) {
      lines.push(`- 最近活动: ${creature.lastActiveAt}`);
    }
    return lines.join("\n");
  }

  formatMirroredMessage(message) {
    const text = trimText(simplifyForChat(message?.text || ""), 20_000);
    return text;
  }

  buildMessageSignature(message) {
    return [
      String(message?.role || "").trim(),
      String(message?.phase || "").trim(),
      String(message?.timestamp || "").trim(),
      trimText(simplifyForChat(message?.text || ""), 2_000),
    ].join("|");
  }

  notePendingUserEcho(roomId, text) {
    const normalized = trimText(text, 2_000);
    if (!normalized) return;
    if (!this.pendingUserEcho[roomId]) {
      this.pendingUserEcho[roomId] = [];
    }
    this.pendingUserEcho[roomId].push(normalized);
    if (this.pendingUserEcho[roomId].length > 20) {
      this.pendingUserEcho[roomId] = this.pendingUserEcho[roomId].slice(-20);
    }
  }

  shouldSkipMirroredUserMessage(roomId, message) {
    const queue = this.pendingUserEcho[roomId];
    if (!queue?.length) {
      return false;
    }
    const normalized = trimText(message?.text || "", 2_000);
    const index = queue.findIndex((item) => item === normalized);
    if (index === -1) {
      return false;
    }
    queue.splice(index, 1);
    return true;
  }

  async mirrorThreadMessagesToRoom(roomId, binding, { backfillLimit = DEFAULT_MESSAGE_BACKFILL_LIMIT } = {}) {
    const payload = await this.getThread(binding.threadId);
    const messages = Array.isArray(payload.session?.messages) ? payload.session.messages : [];
    const previous = this.state.roomMessageCursor[roomId];
    const sameThread = previous?.threadId === binding.threadId;
    const recentSignatures = Array.isArray(previous?.recentSignatures) ? [...previous.recentSignatures] : [];
    let startIndex = sameThread ? Number(previous.count || 0) : 0;

    if (!sameThread) {
      startIndex = Math.max(0, messages.length - Math.max(0, backfillLimit));
    }
    if (startIndex > messages.length) {
      startIndex = messages.length;
    }

    for (const message of messages.slice(startIndex)) {
      if (!message?.text) {
        continue;
      }
      if (message.role !== "assistant") {
        continue;
      }
      const signature = this.buildMessageSignature(message);
      if (recentSignatures.includes(signature)) {
        continue;
      }
      await this.sendText(roomId, this.formatMirroredMessage(message));
      recentSignatures.push(signature);
      if (recentSignatures.length > DEFAULT_RECENT_SIGNATURE_LIMIT) {
        recentSignatures.splice(0, recentSignatures.length - DEFAULT_RECENT_SIGNATURE_LIMIT);
      }
    }

    this.state.roomMessageCursor[roomId] = {
      threadId: binding.threadId,
      count: messages.length,
      lastMessageAt: payload.session?.lastMessageAt || "",
      recentSignatures,
    };

    return payload;
  }

  async fetchRecentRoomMessages(roomId, limit = DEFAULT_ROOM_CLEANUP_SCAN_LIMIT) {
    const payload = await this.matrixRequest("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`, {
      query: {
        dir: "b",
        limit,
      },
    });
    return Array.isArray(payload.chunk) ? payload.chunk : [];
  }

  shouldRedactLegacyNoise(event) {
    if (event?.sender !== this.config.userId) {
      return false;
    }
    if (event?.type !== "m.room.message") {
      return false;
    }
    const body = String(event?.content?.body || "").trim();
    if (!body) {
      return false;
    }
    return body.startsWith("线程状态更新") || body.startsWith("已转发到线程");
  }

  async cleanupLegacyRoomNoise(roomId) {
    const events = await this.fetchRecentRoomMessages(roomId);
    const targets = events.filter((event) => this.shouldRedactLegacyNoise(event));
    if (!targets.length) {
      this.state.roomCleanupDone[roomId] = true;
      return false;
    }

    for (const event of targets) {
      await this.redactEvent(roomId, event.event_id, "remove noisy legacy bridge status");
      await sleep(150);
    }
    this.state.roomCleanupDone[roomId] = true;
    log("cleanup.redacted", roomId, String(targets.length));
    return true;
  }

  async refreshBoundRoomStatuses({ announceChanges = false } = {}) {
    const creatures = await this.getThreadCreatures();
    for (const creature of creatures.slice(0, DEFAULT_ROOM_CREATE_PER_SWEEP * 8)) {
      if (!this.getRoomIdForThread(creature.id)) {
        try {
          await this.ensureRoomForThread(creature, { announce: false });
          break;
        } catch (error) {
          log("room.ensure.error", creature.id, error.message);
        }
      }
    }

    const roomIds = Object.keys(this.state.roomBindings);
    if (!roomIds.length) {
      return;
    }

    const byId = new Map(creatures.map((item) => [item.id, item]));
    let mutated = false;

    for (const roomId of roomIds) {
      const binding = this.state.roomBindings[roomId];
      const previousCursor = this.state.roomMessageCursor[roomId];
      const creature = byId.get(binding.threadId) || null;
      const digest = this.buildStatusDigest(creature);
      if (this.state.roomStatusDigest[roomId] !== digest) {
        this.state.roomStatusDigest[roomId] = digest;
        mutated = true;
      }

      if (creature) {
        const nextBinding = {
          ...binding,
          threadTitle: creature.title || binding.threadTitle,
          threadCwd: creature.cwd || binding.threadCwd,
        };
        this.state.roomBindings[roomId] = nextBinding;
      }

      try {
        if (!this.state.roomCleanupDone[roomId]) {
          const cleaned = await this.cleanupLegacyRoomNoise(roomId);
          if (cleaned) {
            mutated = true;
          }
        }
        await this.mirrorThreadMessagesToRoom(roomId, this.state.roomBindings[roomId], {
          backfillLimit: previousCursor ? 0 : DEFAULT_MESSAGE_BACKFILL_LIMIT,
        });
        mutated = true;
        this.state.roomCleanupDone[roomId] = true;
      } catch (error) {
        log("mirror.error", roomId, binding.threadId, error.message);
      }
    }

    if (mutated) {
      await this.saveState();
    }
  }

  async resolveThreadRef(rawRef) {
    const threadRef = String(rawRef || "").trim();
    if (!threadRef) {
      throw new Error("缺少线程编号或线程 ID。");
    }

    const creatures = await this.getThreadCreatures();
    const exact = creatures.find((item) => item.id === threadRef);
    if (exact) return exact;

    const numeric = Number(threadRef);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= creatures.length) {
      return creatures[numeric - 1];
    }

    const lowered = threadRef.toLowerCase();
    const fuzzy = creatures.filter((item) => String(item.title || "").toLowerCase().includes(lowered));
    if (fuzzy.length === 1) {
      return fuzzy[0];
    }
    if (fuzzy.length > 1) {
      throw new Error(`匹配到多个线程，请改用编号或完整 ID。候选数: ${fuzzy.length}`);
    }

    throw new Error(`找不到线程: ${threadRef}`);
  }

  isAllowedSender(sender) {
    if (sender === this.config.userId) {
      return false;
    }
    if (!this.config.allowedUserIds.length) {
      return true;
    }
    return this.config.allowedUserIds.includes(sender);
  }

  getBinding(roomId) {
    const binding = this.state.roomBindings[roomId];
    return binding && binding.threadId ? binding : null;
  }

  async describeCurrentBinding(roomId) {
    const binding = this.getBinding(roomId);
    if (!binding) {
      return "当前房间还没有绑定线程。";
    }
    const payload = await this.getThread(binding.threadId);
    const session = payload.session || {};
    const lines = [
      `当前绑定线程`,
      `- ID: ${binding.threadId}`,
      `- 标题: ${payload.thread?.title || binding.threadTitle || "未命名线程"}`,
      `- 最近更新: ${payload.thread?.updatedAt || "未知"}`,
      `- 状态: ${payload.activeRun ? "running" : session.status || "idle"}`,
    ];
    if (session.preview) {
      lines.push(`- 最近内容: ${trimText(session.preview, 140)}`);
    }
    return lines.join("\n");
  }

  async postGlobalStatus(roomId) {
    const creatures = await this.getThreadCreatures();
    const running = creatures.filter((item) => item.state === "running");
    const waiting = creatures.filter((item) => item.state === "waiting");
    const dead = creatures.filter((item) => item.state === "dead");
    const lines = [
      "Codex 状态",
      `- 总线程: ${creatures.length}`,
      `- 运行中: ${running.length}`,
      `- 等待中: ${waiting.length}`,
      `- 卡住: ${dead.length}`,
      "",
      "最近线程",
      ...creatures.slice(0, Math.max(1, this.config.threadListLimit)).map((item, index) => this.formatCreatureLine(item, index)),
      "",
      "常用命令",
      "!codex threads",
      "!codex bind 1",
      "!codex room 1",
      "!codex say 1 :: 好的，继续执行",
      `!codex new ${this.config.defaultCwd} :: 你的任务描述`,
    ];
    await this.sendNotice(roomId, lines.join("\n"));
  }

  async postThreadList(roomId) {
    const creatures = await this.getThreadCreatures();
    const lines = [
      "线程列表",
      ...creatures.slice(0, Math.max(1, this.config.threadListLimit)).map((item, index) => this.formatCreatureLine(item, index)),
    ];
    await this.sendNotice(roomId, lines.join("\n"));
  }

  async postRoomBindings(roomId) {
    const entries = Object.entries(this.state.roomBindings);
    if (!entries.length) {
      await this.sendNotice(roomId, "当前还没有任何房间绑定到线程。");
      return;
    }
    const lines = ["已绑定房间"];
    for (const [boundRoomId, binding] of entries) {
      lines.push(`- ${boundRoomId} -> ${binding.threadTitle || binding.threadId}`);
    }
    await this.sendNotice(roomId, lines.join("\n"));
  }

  async bindRoomToThread(roomId, sender, thread) {
    this.state.roomBindings[roomId] = {
      threadId: thread.id,
      threadTitle: thread.title || "",
      threadCwd: thread.cwd || "",
      boundAt: new Date().toISOString(),
      boundBy: sender,
    };
    delete this.state.roomStatusDigest[roomId];
    delete this.state.roomMessageCursor[roomId];
    delete this.state.roomCleanupDone[roomId];
    await this.saveState();
    await this.sendNotice(roomId, [
      `当前房间已绑定到线程 ${thread.id}`,
      `${thread.title || "未命名线程"}`,
      "",
      "以后你在这个房间里直接发普通文本，我会转发给这个线程。",
    ].join("\n"));
    await this.refreshBoundRoomStatuses({ announceChanges: false });
  }

  async unbindRoom(roomId) {
    delete this.state.roomBindings[roomId];
    delete this.state.roomStatusDigest[roomId];
    delete this.state.roomMessageCursor[roomId];
    delete this.state.roomCleanupDone[roomId];
    await this.saveState();
    await this.sendNotice(roomId, "当前房间已解除线程绑定。");
  }

  parseCommand(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed.startsWith("!codex")) {
      return null;
    }

    const body = trimmed.slice("!codex".length).trim();
    if (!body) {
      return { name: "help" };
    }

    if (body.startsWith("say ")) {
      const payload = body.slice(4);
      const [left, right] = payload.split(/\s*::\s*/, 2);
      return { name: "say", ref: left?.trim(), message: right?.trim() || "" };
    }

    if (body.startsWith("new")) {
      const payload = body.slice(3).trim();
      const [left, right] = payload.split(/\s*::\s*/, 2);
      return { name: "new", cwd: left?.trim() || "", prompt: right?.trim() || "" };
    }

    const [name, ...rest] = body.split(/\s+/);
    return { name: name.toLowerCase(), args: rest };
  }

  async handleCommand(event, command) {
    const roomId = event.room_id;
    const sender = event.sender;

    switch (command.name) {
      case "help":
        await this.sendNotice(roomId, [
          "可用命令",
          "!codex status",
          "!codex threads",
          "!codex rooms",
          "!codex bind <thread-ref>",
          "!codex unbind",
          "!codex who",
          "!codex say <thread-ref> :: <message>",
          "!codex new [cwd] :: <prompt>",
          "!codex room <thread-ref>",
          "",
          "房间已绑定线程后，直接发普通文本就会转发给线程。",
        ].join("\n"));
        return;

      case "status":
        if (roomId === this.config.dispatchRoomId) {
          await this.postGlobalStatus(roomId);
        } else {
          await this.sendNotice(roomId, await this.describeCurrentBinding(roomId));
        }
        return;

      case "threads":
        await this.postThreadList(roomId);
        return;

      case "rooms":
        await this.postRoomBindings(roomId);
        return;

      case "who":
        await this.sendNotice(roomId, await this.describeCurrentBinding(roomId));
        return;

      case "bind": {
        if (roomId === this.config.dispatchRoomId) {
          throw new Error("总控房间不能直接绑定线程。请使用 `!codex room <thread-ref>` 创建项目房间。");
        }
        const thread = await this.resolveThreadRef(command.args?.[0]);
        await this.bindRoomToThread(roomId, sender, thread);
        return;
      }

      case "unbind":
        if (roomId === this.config.dispatchRoomId) {
          throw new Error("总控房间没有线程绑定。");
        }
        await this.unbindRoom(roomId);
        return;

      case "room": {
        if (roomId !== this.config.dispatchRoomId) {
          throw new Error("创建项目房间只能在 dispatch room 里执行。");
        }
        const thread = await this.resolveThreadRef(command.args?.[0]);
        const newRoomId = await this.ensureRoomForThread(thread, { sender, announce: false });
        await this.sendNotice(roomId, `已创建项目房间 ${newRoomId} ，并绑定到线程 ${thread.id}`);
        return;
      }

      case "say": {
        if (!command.ref || !command.message) {
          throw new Error("格式错误，应为: !codex say <thread-ref> :: <message>");
        }
        const thread = await this.resolveThreadRef(command.ref);
        await this.resumeThread(thread.id, command.message);
        await this.sendNotice(roomId, `已发送到线程 ${thread.id}`);
        return;
      }

      case "new": {
        if (!command.prompt) {
          throw new Error("格式错误，应为: !codex new [cwd] :: <prompt>");
        }
        const cwd = command.cwd || this.config.defaultCwd;
        const created = await this.createThread(command.prompt, cwd);
        let newRoomId = "";
        if (created.run?.threadId) {
          try {
            const thread = await this.resolveThreadRef(created.run.threadId);
            newRoomId = await this.ensureRoomForThread(thread, { sender, announce: false });
          } catch (error) {
            log("room.autocreate.error", created.run.threadId, error.message);
          }
        }
        await this.sendNotice(roomId, [
          "已创建新任务。",
          `- 目录: ${cwd}`,
          `- runId: ${created.run?.id || "unknown"}`,
          created.run?.threadId ? `- threadId: ${created.run.threadId}` : "- threadId: 等待 Codex 返回",
          newRoomId ? `- roomId: ${newRoomId}` : "- roomId: 稍后自动创建",
        ].join("\n"));
        return;
      }

      default:
        throw new Error(`未知命令: ${command.name}`);
    }
  }

  async handleBoundRoomText(event, binding) {
    const message = String(event.content?.body || "").trim();
    if (!message) {
      return;
    }
    log("forward.to.codex", binding.threadId, trimText(message, 120));
    await this.resumeThread(binding.threadId, message);
  }

  async handleEvent(roomId, event) {
    if (!event || event.type !== "m.room.message") {
      return;
    }
    if (event.sender === this.config.userId) {
      return;
    }
    if (!this.isAllowedSender(event.sender)) {
      return;
    }

    const msgtype = String(event.content?.msgtype || "");
    if (msgtype !== "m.text") {
      return;
    }

    const body = String(event.content?.body || "").trim();
    if (!body) {
      return;
    }

    const binding = this.getBinding(roomId);
    const command = this.parseCommand(body);

    try {
      if (command) {
        await this.handleCommand({ ...event, room_id: roomId }, command);
        return;
      }

      if (binding) {
        await this.handleBoundRoomText({ ...event, room_id: roomId }, binding);
        return;
      }

      if (roomId === this.config.dispatchRoomId) {
        await this.sendNotice(roomId, "请使用 `!codex help` 查看命令。总控房间里的普通文本不会自动转发。");
      }
    } catch (error) {
      await this.sendNotice(roomId, `命令失败: ${error.message}`);
    }
  }

  async syncOnce() {
    const response = await this.matrixRequest("GET", "/_matrix/client/v3/sync", {
      query: {
        timeout: this.config.syncTimeoutMs,
        since: this.state.sinceToken || undefined,
      },
    });

    const shouldProcess = Boolean(this.state.sinceToken);
    this.state.sinceToken = response.next_batch || this.state.sinceToken;
    await this.saveState();

    if (!shouldProcess) {
      log("sync.initialized");
      return;
    }

    const joined = response.rooms?.join || {};
    for (const [roomId, roomData] of Object.entries(joined)) {
      const events = Array.isArray(roomData.timeline?.events) ? roomData.timeline.events : [];
      for (const event of events) {
        await this.handleEvent(roomId, event);
      }
    }
  }

  async runOnce() {
    await this.syncOnce();
    await this.refreshBoundRoomStatuses({ announceChanges: false });
  }

  async runLoop() {
    this.running = true;
    this.statusTimer = setInterval(() => {
      this.refreshBoundRoomStatuses({ announceChanges: true }).catch((error) => {
        log("status.refresh.error", error.message);
      });
    }, Math.max(5_000, this.config.statusPollMs));

    while (this.running) {
      try {
        await this.syncOnce();
      } catch (error) {
        log("sync.error", error.message);
        await sleep(5_000);
      }
    }
  }

  stop() {
    this.running = false;
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const config = await loadConfig(options.configPath);
  validateConfig(config);

  const bridge = new MatrixBridge(config, options);
  await bridge.init();

  process.on("SIGINT", () => {
    log("signal", "SIGINT");
    bridge.stop();
  });
  process.on("SIGTERM", () => {
    log("signal", "SIGTERM");
    bridge.stop();
  });

  if (options.once) {
    await bridge.runOnce();
    return;
  }

  await bridge.runLoop();
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
