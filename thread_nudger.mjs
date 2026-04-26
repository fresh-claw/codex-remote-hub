import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORK_CENTER_ROOT = __dirname;
const DEFAULT_CONFIG_PATH = path.join(WORK_CENTER_ROOT, "config", "thread_nudger.json");
const DEFAULT_STATE_DIR = path.join(WORK_CENTER_ROOT, "state", "thread_nudger");
const DEFAULT_STATE_FILE = path.join(DEFAULT_STATE_DIR, "state.json");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const STATE_DB = process.env.CODEX_STATE_DB || path.join(CODEX_HOME, "state_5.sqlite");
const CODEX_CLI_ENTRY = process.env.CODEX_CLI_ENTRY || "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js";
const DEFAULT_EXEC_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const MAX_TAIL_BYTES = 1024 * 1024;
const THREAD_DEAD_THRESHOLD_MS = 15 * 60 * 1000;
const localActiveRuns = new Map();

const DEFAULT_CONFIG = {
  enabled: true,
  pollIntervalMs: 5 * 60 * 1000,
  threadLimit: 12,
  idleMinutes: 15,
  cooldownMinutes: 30,
  maxThreadsPerCycle: 1,
  maxNudgesPerThreadPerDay: 0,
  recentThreadHours: 48,
  requireAssistantLast: true,
  onlyStates: ["waiting", "dead"],
  promptSequence: ["进度？", "继续", "卡住了吗？"],
  includeTitlePatterns: [],
  excludeTitlePatterns: [],
  includeCwdPatterns: [],
  excludeCwdPatterns: [],
};

function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}

function trimText(text, max = 120) {
  if (!text) return "";
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function toMillis(value) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function latestIso(...values) {
  let latestValue = null;
  let latestTimestamp = 0;
  for (const value of values) {
    const timestamp = toMillis(value);
    if (!timestamp || timestamp < latestTimestamp) continue;
    latestTimestamp = timestamp;
    latestValue = value;
  }
  return latestValue;
}

function normalizePatterns(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeConfig(raw = {}) {
  const promptSequence = normalizePatterns(raw.promptSequence);
  const fallbackPrompt = String(raw.prompt || "").trim();
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    pollIntervalMs: Math.max(60_000, Number(raw.pollIntervalMs) || DEFAULT_CONFIG.pollIntervalMs),
    threadLimit: Math.max(1, Math.min(Number(raw.threadLimit) || DEFAULT_CONFIG.threadLimit, 120)),
    idleMinutes: Math.max(1, Number(raw.idleMinutes) || DEFAULT_CONFIG.idleMinutes),
    cooldownMinutes: Math.max(1, Number(raw.cooldownMinutes) || DEFAULT_CONFIG.cooldownMinutes),
    maxThreadsPerCycle: Math.max(1, Number(raw.maxThreadsPerCycle) || DEFAULT_CONFIG.maxThreadsPerCycle),
    maxNudgesPerThreadPerDay: Math.max(0, Number(raw.maxNudgesPerThreadPerDay) || DEFAULT_CONFIG.maxNudgesPerThreadPerDay),
    recentThreadHours: Math.max(1, Number(raw.recentThreadHours) || DEFAULT_CONFIG.recentThreadHours),
    requireAssistantLast: raw.requireAssistantLast !== false,
    onlyStates: normalizePatterns(raw.onlyStates).length ? normalizePatterns(raw.onlyStates) : [...DEFAULT_CONFIG.onlyStates],
    promptSequence: promptSequence.length ? promptSequence : (fallbackPrompt ? [fallbackPrompt] : [...DEFAULT_CONFIG.promptSequence]),
    includeTitlePatterns: normalizePatterns(raw.includeTitlePatterns),
    excludeTitlePatterns: normalizePatterns(raw.excludeTitlePatterns),
    includeCwdPatterns: normalizePatterns(raw.includeCwdPatterns),
    excludeCwdPatterns: normalizePatterns(raw.excludeCwdPatterns),
    stateFile: String(raw.stateFile || DEFAULT_STATE_FILE).trim() || DEFAULT_STATE_FILE,
  };
}

async function loadConfig(configPath) {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return mergeConfig(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return mergeConfig({});
    }
    throw error;
  }
}

async function readState(stateFile) {
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid state");
    }
    return {
      version: 1,
      threads: {},
      ...parsed,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        version: 1,
        updatedAt: null,
        lastTickAt: null,
        threads: {},
      };
    }
    throw error;
  }
}

async function writeState(stateFile, state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const tempFile = `${stateFile}.${randomUUID()}.tmp`;
  const payload = {
    version: 1,
    ...state,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tempFile, stateFile);
}

function patternMatch(value, patterns) {
  const haystack = String(value || "").toLowerCase();
  if (!haystack) return false;
  return patterns.some((pattern) => haystack.includes(String(pattern || "").toLowerCase()));
}

function getLastSpeaker(thread) {
  const lastAssistant = toMillis(thread.lastAssistantAt);
  const lastUser = toMillis(thread.lastUserAt);
  if (!lastAssistant && !lastUser) return null;
  return lastAssistant >= lastUser ? "assistant" : "user";
}

function getThreadHistory(state, threadId) {
  if (!state.threads || typeof state.threads !== "object") {
    state.threads = {};
  }
  if (!state.threads[threadId]) {
    state.threads[threadId] = {
      lastSentAt: null,
      lastPrompt: null,
      countDate: null,
      countToday: 0,
      history: [],
    };
  }
  return state.threads[threadId];
}

function resetDailyCounter(entry, dateKey) {
  if (entry.countDate === dateKey) return;
  entry.countDate = dateKey;
  entry.countToday = 0;
}

function choosePrompt(entry, config) {
  const prompts = Array.isArray(config.promptSequence) && config.promptSequence.length
    ? config.promptSequence
    : DEFAULT_CONFIG.promptSequence;
  return prompts[entry.countToday % prompts.length];
}

function shell(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
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

async function sqliteJson(sql) {
  const { stdout } = await shell("sqlite3", ["-json", STATE_DB, sql]);
  if (!stdout.trim()) {
    return [];
  }
  return JSON.parse(stdout);
}

async function readJsonlTail(filePath, maxBytes = MAX_TAIL_BYTES) {
  if (!filePath) return [];
  const handle = await fs.open(filePath, "r");
  try {
    const stats = await handle.stat();
    const readBytes = Math.min(stats.size, maxBytes);
    const start = Math.max(0, stats.size - readBytes);
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    const entries = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // Ignore partial/corrupt line fragments in the tail window.
      }
    }
    return entries;
  } finally {
    await handle.close();
  }
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

function summarizeTail(entries) {
  const summary = {
    status: deriveStatus(entries),
    preview: "",
    lastMessageAt: null,
    lastUserAt: null,
    lastAssistantAt: null,
    lastEventAt: null,
    lastProgressAt: null,
    lastVisibleAt: null,
    reasoningKind: null,
  };

  let lastUserMessage = "";
  let lastAssistantMessage = "";

  for (const entry of entries) {
    const timestamp = entry.timestamp || null;
    summary.lastEventAt = latestIso(summary.lastEventAt, timestamp);

    if (entry.type === "turn.started" || entry.type === "turn.completed") {
      summary.lastProgressAt = latestIso(summary.lastProgressAt, timestamp);
      continue;
    }

    if (entry.type === "response_item" && entry.payload?.type === "reasoning") {
      summary.lastProgressAt = latestIso(summary.lastProgressAt, timestamp);
      summary.reasoningKind = summary.reasoningKind || "background_reasoning";
      continue;
    }

    if (entry.type !== "event_msg" || !entry.payload) {
      continue;
    }

    if (entry.payload.type === "user_message") {
      summary.lastUserAt = latestIso(summary.lastUserAt, timestamp);
      summary.lastVisibleAt = latestIso(summary.lastVisibleAt, timestamp);
      summary.lastProgressAt = latestIso(summary.lastProgressAt, timestamp);
      summary.lastMessageAt = latestIso(summary.lastMessageAt, timestamp);
      lastUserMessage = String(entry.payload.message || "").trim();
      continue;
    }

    if (entry.payload.type === "agent_message") {
      summary.lastAssistantAt = latestIso(summary.lastAssistantAt, timestamp);
      summary.lastVisibleAt = latestIso(summary.lastVisibleAt, timestamp);
      summary.lastProgressAt = latestIso(summary.lastProgressAt, timestamp);
      summary.lastMessageAt = latestIso(summary.lastMessageAt, timestamp);
      lastAssistantMessage = String(entry.payload.message || "").trim();
      continue;
    }

    if (entry.payload.type === "agent_reasoning") {
      summary.lastProgressAt = latestIso(summary.lastProgressAt, timestamp);
      summary.reasoningKind = inferReasoningKind(entry.payload.text);
      continue;
    }

    if (entry.payload.type === "task_started" || entry.payload.type === "task_complete") {
      summary.lastProgressAt = latestIso(summary.lastProgressAt, timestamp);
    }
  }

  summary.preview = trimText(lastAssistantMessage || lastUserMessage || "");
  summary.lastProgressAt = latestIso(summary.lastProgressAt, summary.lastEventAt, summary.lastMessageAt);
  return summary;
}

function classifyThread(thread, session, nowMs) {
  const threadUpdatedAt = thread.updatedAt;
  const localRun = localActiveRuns.get(thread.id) || null;
  const lastActiveAt = latestIso(
    localRun?.startedAt || null,
    session.lastProgressAt,
    session.lastVisibleAt,
    session.lastMessageAt,
    threadUpdatedAt,
  );
  const staleMs = lastActiveAt ? Math.max(0, nowMs - toMillis(lastActiveAt)) : 0;
  const isRunning = Boolean(localRun || session.status === "running");
  const isDead = isRunning && staleMs >= THREAD_DEAD_THRESHOLD_MS;

  let state = "waiting";
  let stateLabel = "等待新指令";
  if (isRunning && !isDead) {
    state = "running";
    stateLabel = "正在执行";
  } else if (isDead) {
    state = "dead";
    stateLabel = "卡住了";
  }

  return {
    ...thread,
    state,
    stateLabel,
    canSend: !isRunning,
    lastActiveAt,
    lastUserAt: session.lastUserAt || null,
    lastAssistantAt: session.lastAssistantAt || null,
    lastMessageAt: session.lastMessageAt || null,
    reasoningKind: session.reasoningKind || null,
    sessionStatus: session.status || "idle",
    preview: session.preview || "",
  };
}

async function listThreads(config) {
  const sql = `
    select
      id,
      title,
      cwd,
      rollout_path,
      updated_at,
      archived
    from threads
    order by updated_at desc
    limit ${Math.max(1, Math.min(Number(config.threadLimit) || DEFAULT_CONFIG.threadLimit, 120))}
  `;
  const rows = await sqliteJson(sql);
  const nowMs = Date.now();
  const threads = [];

  for (const row of rows) {
    const entries = await readJsonlTail(row.rollout_path);
    const session = summarizeTail(entries);
    threads.push(classifyThread({
      id: row.id,
      title: row.title || "未命名线程",
      cwd: row.cwd || "",
      archived: Boolean(row.archived),
      rolloutPath: row.rollout_path,
      updatedAt: row.updated_at ? new Date(Number(row.updated_at) * 1000).toISOString() : null,
    }, session, nowMs));
  }

  return threads;
}

function shouldIncludeThread(thread, config, nowMs, entry) {
  if (!thread || !thread.id) return { ok: false, reason: "missing-id" };
  if (thread.archived) return { ok: false, reason: "archived" };
  if (!thread.canSend) return { ok: false, reason: "busy" };
  if (!config.onlyStates.includes(thread.state)) return { ok: false, reason: `state:${thread.state}` };

  const title = String(thread.title || "");
  const cwd = String(thread.cwd || "");
  if (config.includeTitlePatterns.length && !patternMatch(title, config.includeTitlePatterns)) {
    return { ok: false, reason: "title-not-included" };
  }
  if (config.excludeTitlePatterns.length && patternMatch(title, config.excludeTitlePatterns)) {
    return { ok: false, reason: "title-excluded" };
  }
  if (config.includeCwdPatterns.length && !patternMatch(cwd, config.includeCwdPatterns)) {
    return { ok: false, reason: "cwd-not-included" };
  }
  if (config.excludeCwdPatterns.length && patternMatch(cwd, config.excludeCwdPatterns)) {
    return { ok: false, reason: "cwd-excluded" };
  }

  const recentCutoffMs = nowMs - (config.recentThreadHours * 60 * 60 * 1000);
  const updatedMs = toMillis(thread.updatedAt || thread.lastMessageAt || thread.lastActiveAt);
  if (!updatedMs || updatedMs < recentCutoffMs) {
    return { ok: false, reason: "too-old" };
  }

  const idleCutoffMs = nowMs - (config.idleMinutes * 60 * 1000);
  const lastActiveMs = toMillis(thread.lastActiveAt || thread.lastMessageAt || thread.updatedAt);
  if (!lastActiveMs || lastActiveMs > idleCutoffMs) {
    return { ok: false, reason: "not-idle-long-enough" };
  }

  if (config.requireAssistantLast && getLastSpeaker(thread) !== "assistant") {
    return { ok: false, reason: "assistant-not-last-speaker" };
  }

  const lastSentMs = toMillis(entry.lastSentAt);
  if (lastSentMs && (nowMs - lastSentMs) < (config.cooldownMinutes * 60 * 1000)) {
    return { ok: false, reason: "cooldown" };
  }

  if (config.maxNudgesPerThreadPerDay > 0 && entry.countToday >= config.maxNudgesPerThreadPerDay) {
    return { ok: false, reason: "daily-limit" };
  }

  return { ok: true };
}

function spawnCodexResume(thread, prompt) {
  const runId = randomUUID();
  const run = {
    id: runId,
    threadId: thread.id,
    prompt,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  localActiveRuns.set(thread.id, run);

  const child = spawn(process.execPath, [
    CODEX_CLI_ENTRY,
    "exec",
    "resume",
    "--json",
    "--full-auto",
    thread.id,
    prompt,
  ], {
    cwd: thread.cwd || process.cwd(),
    env: {
      ...process.env,
      PATH: [process.env.PATH || "", DEFAULT_EXEC_PATH].filter(Boolean).join(":"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const closeRun = () => {
    localActiveRuns.delete(thread.id);
  };

  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  child.on("close", closeRun);
  child.on("error", closeRun);
  return run;
}

async function runCycle(config, state, options = {}) {
  const now = new Date();
  const nowMs = now.getTime();
  const dateKey = now.toISOString().slice(0, 10);
  const threads = await listThreads(config);
  const candidates = [];

  for (const thread of threads) {
    const entry = getThreadHistory(state, thread.id);
    resetDailyCounter(entry, dateKey);
    const verdict = shouldIncludeThread(thread, config, nowMs, entry);
    if (!verdict.ok) continue;
    candidates.push({
      thread,
      entry,
      staleMs: Math.max(0, nowMs - toMillis(thread.lastActiveAt || thread.lastMessageAt || thread.updatedAt)),
    });
  }

  candidates.sort((left, right) => right.staleMs - left.staleMs);
  const selected = candidates.slice(0, config.maxThreadsPerCycle);

  if (!selected.length) {
    log("nudger.idle", "no-candidates");
    state.lastTickAt = now.toISOString();
    return;
  }

  for (const item of selected) {
    const prompt = choosePrompt(item.entry, config);
    const title = trimText(item.thread.title || item.thread.id, 48);
    if (options.dryRun) {
      log("nudger.dry-run", item.thread.id, JSON.stringify({
        title,
        prompt,
        state: item.thread.state,
        lastActiveAt: item.thread.lastActiveAt,
      }));
      continue;
    }

    try {
      spawnCodexResume(item.thread, prompt);
      item.entry.lastSentAt = new Date().toISOString();
      item.entry.lastPrompt = prompt;
      item.entry.countToday += 1;
      item.entry.history = [
        ...(Array.isArray(item.entry.history) ? item.entry.history : []),
        {
          at: item.entry.lastSentAt,
          prompt,
          state: item.thread.state,
          title: item.thread.title || "",
        },
      ].slice(-20);
      log("nudger.sent", item.thread.id, JSON.stringify({ title, prompt }));
    } catch (error) {
      item.entry.history = [
        ...(Array.isArray(item.entry.history) ? item.entry.history : []),
        {
          at: new Date().toISOString(),
          prompt,
          error: error.message,
        },
      ].slice(-20);
      log("nudger.error", item.thread.id, JSON.stringify({
        title,
        prompt,
        error: error.message,
      }));
    }
  }

  state.lastTickAt = now.toISOString();
}

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    once: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config" && argv[index + 1]) {
      options.configPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--once") {
      options.once = true;
      continue;
    }
    if (value === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (value === "--help" || value === "-h") {
      console.log(`Usage: node ${path.basename(__filename)} [--config FILE] [--once] [--dry-run]`);
      process.exit(0);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  log("nudger.start", JSON.stringify({
    configPath: options.configPath,
    once: options.once,
    dryRun: options.dryRun,
    host: os.hostname(),
  }));

  while (true) {
    try {
      const config = await loadConfig(options.configPath);
      const state = await readState(config.stateFile || DEFAULT_STATE_FILE);
      if (config.enabled === false) {
        log("nudger.skip", "disabled");
      } else {
        await runCycle(config, state, options);
      }
      await writeState(config.stateFile || DEFAULT_STATE_FILE, state);
      if (options.once) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    } catch (error) {
      log("nudger.fatal", error.stack || error.message);
      if (options.once) {
        process.exitCode = 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }
}

main();
