const SYNC_INTERVAL_MS = 60 * 1000;

const state = {
  authenticated: false,
  csrfToken: "",
  threads: [],
  selectedThreadId: null,
  selectedThread: null,
  selectedSession: null,
  syncTimer: null,
  toastTimer: null,
  isLoading: false,
  isSending: false,
  pendingMessage: null,
  autopilot: null,
  autopilotOpen: false,
  isSavingAutopilot: false,
};

const routeBase = (() => {
  const pathname = window.location.pathname;
  const knownSuffixes = ["/thread-chat", "/thread-chat.html"];
  const matched = knownSuffixes.find((suffix) => pathname.endsWith(suffix));
  if (!matched) return "";
  const prefix = pathname.slice(0, -matched.length);
  return prefix === "/" ? "" : prefix;
})();

function withBase(pathname) {
  return `${routeBase}${pathname}`;
}

const loginGate = document.getElementById("loginGate");
const loginForm = document.getElementById("loginForm");
const passwordInput = document.getElementById("passwordInput");
const loginButton = document.getElementById("loginButton");
const loginError = document.getElementById("loginError");
const appShell = document.getElementById("appShell");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
const mobileThreadButton = document.getElementById("mobileThreadButton");
const sidebarCloseButton = document.getElementById("sidebarCloseButton");
const logoutButton = document.getElementById("logoutButton");
const refreshButton = document.getElementById("refreshButton");
const syncBadge = document.getElementById("syncBadge");
const threadCountLabel = document.getElementById("threadCountLabel");
const threadList = document.getElementById("threadList");
const threadStateLabel = document.getElementById("threadStateLabel");
const threadTitle = document.getElementById("threadTitle");
const threadActiveAt = document.getElementById("threadActiveAt");
const threadCanSend = document.getElementById("threadCanSend");
const autopilotToggleButton = document.getElementById("autopilotToggleButton");
const autopilotPanel = document.getElementById("autopilotPanel");
const autopilotStateText = document.getElementById("autopilotStateText");
const autopilotEnabledInput = document.getElementById("autopilotEnabledInput");
const autopilotIntervalInput = document.getElementById("autopilotIntervalInput");
const autopilotCooldownInput = document.getElementById("autopilotCooldownInput");
const autopilotMaxThreadsInput = document.getElementById("autopilotMaxThreadsInput");
const autopilotStepsInput = document.getElementById("autopilotStepsInput");
const autopilotDoneInput = document.getElementById("autopilotDoneInput");
const autopilotSaveButton = document.getElementById("autopilotSaveButton");
const autopilotRunButton = document.getElementById("autopilotRunButton");
const autopilotStatus = document.getElementById("autopilotStatus");
const messageList = document.getElementById("messageList");
const composerInput = document.getElementById("composerInput");
const sendButton = document.getElementById("sendButton");
const composerStatus = document.getElementById("composerStatus");
const quickButtons = Array.from(document.querySelectorAll("[data-quick-message]"));
const toast = document.getElementById("toast");

function syncViewportHeight() {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--viewport-height", `${Math.round(viewportHeight)}px`);
}

function settleViewportAfterKeyboard() {
  window.setTimeout(() => {
    syncViewportHeight();
    composerInput.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, 120);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shorten(value, max = 72) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function threadInitial(value) {
  const text = String(value || "").trim();
  if (!text) return "C";
  const first = Array.from(text)[0] || "C";
  return first.toUpperCase();
}

function roleLabel(role) {
  if (role === "user") return "你";
  if (role === "assistant") return "Codex";
  return "系统";
}

function statusTone(stateValue) {
  if (stateValue === "running") return "state-running";
  if (stateValue === "dead") return "state-dead";
  return "state-waiting";
}

function relativeTime(value) {
  if (!value) return "--";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "--";
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function timeStamp(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isNearBottom(element, threshold = 80) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

async function fetchJson(pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  const method = String(options.method || "GET").toUpperCase();
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (method !== "GET" && method !== "HEAD" && state.csrfToken) {
    headers.set("x-thread-chat-csrf", state.csrfToken);
  }

  const response = await fetch(withBase(pathname), {
    credentials: "same-origin",
    ...options,
    headers,
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const message = typeof payload === "object" && payload?.error
      ? payload.error
      : `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return payload;
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.remove("hidden");
  state.toastTimer = window.setTimeout(() => {
    toast.classList.add("hidden");
  }, 2400);
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 960px)").matches;
}

function closeSidebarDrawer() {
  appShell.classList.remove("sidebar-open");
  sidebarBackdrop.classList.add("hidden");
}

function openSidebarDrawer() {
  if (!isMobileLayout()) return;
  appShell.classList.add("sidebar-open");
  sidebarBackdrop.classList.remove("hidden");
  window.requestAnimationFrame(() => {
    document.querySelector(".thread-item.active")?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  });
}

function syncSidebarDrawer() {
  if (!isMobileLayout()) {
    closeSidebarDrawer();
  }
}

function setAuthenticated(authenticated) {
  state.authenticated = authenticated;
  loginGate.classList.toggle("hidden", authenticated);
  appShell.classList.toggle("hidden", !authenticated);
  if (!authenticated) {
    closeSidebarDrawer();
  }
}

function setComposerState(canSend) {
  const enabled = canSend && !state.isSending;
  composerInput.disabled = !enabled;
  sendButton.disabled = !enabled;
  quickButtons.forEach((button) => {
    button.disabled = !enabled;
  });

  if (state.isSending) {
    threadCanSend.textContent = "发送中";
    threadCanSend.className = "send-badge pending";
    composerStatus.textContent = "正在把消息发给这个线程";
    sendButton.textContent = "发送中...";
    composerInput.placeholder = "正在发送，请稍候";
    return;
  }

  threadCanSend.textContent = canSend ? "可发送" : "执行中";
  threadCanSend.className = `send-badge ${canSend ? "ready" : "blocked"}`;
  composerStatus.textContent = canSend ? "按 ⌘/Ctrl + Enter 发送" : "这个线程正在跑，等这一轮结束后再发";
  sendButton.textContent = "发送";
  composerInput.placeholder = canSend ? "直接向当前线程发送消息" : "当前线程仍在执行，等这一轮结束后再发送";
}

function linesFromTextarea(value) {
  return String(value || "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderAutopilotPanel() {
  const payload = state.autopilot;
  const config = payload?.config || {};
  const script = config.scripts?.[0] || {};
  const steps = Array.isArray(script.steps) ? script.steps : [];

  autopilotPanel.classList.toggle("hidden", !state.autopilotOpen);
  autopilotToggleButton.classList.toggle("active", state.autopilotOpen);
  autopilotEnabledInput.checked = config.enabled === true;
  autopilotStateText.textContent = config.enabled ? "开启" : "关闭";
  autopilotIntervalInput.value = String(config.intervalMinutes || 15);
  autopilotCooldownInput.value = String(config.cooldownMinutes || 15);
  autopilotMaxThreadsInput.value = String(config.maxThreadsPerTick || 2);
  autopilotStepsInput.value = steps.map((step) => step.message).filter(Boolean).join("\n") || "继续";
  autopilotDoneInput.value = (config.completionPatterns || []).join("\n");
  autopilotStatus.textContent = payload?.state?.lastTickAt
    ? `上次执行 ${timeStamp(payload.state.lastTickAt)}`
    : "尚未执行";
}

function buildAutopilotConfigFromForm() {
  const current = state.autopilot?.config || {};
  return {
    ...current,
    enabled: autopilotEnabledInput.checked,
    intervalMinutes: Number(autopilotIntervalInput.value) || 15,
    cooldownMinutes: Number(autopilotCooldownInput.value) || 15,
    maxThreadsPerTick: Number(autopilotMaxThreadsInput.value) || 2,
    completionPatterns: linesFromTextarea(autopilotDoneInput.value),
    scripts: [
      {
        id: current.scripts?.[0]?.id || "night-default",
        name: current.scripts?.[0]?.name || "夜间继续",
        enabled: true,
        mode: "sequence",
        steps: linesFromTextarea(autopilotStepsInput.value).map((message) => ({
          condition: "idle",
          message,
        })),
      },
    ],
  };
}

async function loadAutopilot() {
  if (!state.authenticated) return;
  state.autopilot = await fetchJson("/api/chat-ui/autopilot");
  renderAutopilotPanel();
}

async function saveAutopilot() {
  if (state.isSavingAutopilot) return;
  state.isSavingAutopilot = true;
  autopilotSaveButton.disabled = true;
  autopilotSaveButton.textContent = "保存中...";
  try {
    state.autopilot = await fetchJson("/api/chat-ui/autopilot", {
      method: "PUT",
      body: JSON.stringify({ config: buildAutopilotConfigFromForm() }),
    });
    renderAutopilotPanel();
    showToast("托管编排已保存");
  } finally {
    state.isSavingAutopilot = false;
    autopilotSaveButton.disabled = false;
    autopilotSaveButton.textContent = "保存编排";
  }
}

async function runAutopilotNow() {
  autopilotRunButton.disabled = true;
  autopilotRunButton.textContent = "执行中...";
  try {
    const result = await fetchJson("/api/chat-ui/autopilot/tick", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const sentCount = result.sent?.length || 0;
    showToast(sentCount ? `已推进 ${sentCount} 个线程` : "没有符合条件的线程");
    await loadAutopilot();
    await refreshAll({ forceScroll: false });
  } finally {
    autopilotRunButton.disabled = false;
    autopilotRunButton.textContent = "立即执行一次";
  }
}

function renderThreads() {
  threadList.innerHTML = "";
  threadCountLabel.textContent = `${state.threads.length} 个线程`;
  if (mobileThreadButton) {
    mobileThreadButton.textContent = `切换线程 · ${state.threads.length}`;
  }

  if (!state.threads.length) {
    const empty = document.createElement("div");
    empty.className = "thread-item";
    empty.textContent = "还没有可显示的线程。";
    threadList.appendChild(empty);
    return;
  }

  for (const thread of state.threads) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `thread-item${thread.id === state.selectedThreadId ? " active" : ""}`;
    button.title = thread.title || "未命名线程";
    button.innerHTML = `
      <div class="thread-item-avatar">${escapeHtml(threadInitial(thread.title))}</div>
      <div class="thread-item-content">
        <div class="thread-item-head">
          <span class="thread-item-title">${escapeHtml(shorten(thread.title, 36))}</span>
          <span class="thread-item-time">${escapeHtml(relativeTime(thread.lastActiveAt || thread.updatedAt))}</span>
        </div>
        <div class="thread-item-meta">
          <span class="status-dot ${statusTone(thread.state)}"></span>
          <span class="thread-item-state">${escapeHtml(thread.stateLabel || "等待中")}</span>
        </div>
      </div>
    `;
    button.addEventListener("click", () => {
      if (thread.id === state.selectedThreadId) return;
      state.selectedThreadId = thread.id;
      renderThreads();
      closeSidebarDrawer();
      loadThread(thread.id, { forceScroll: true }).catch((error) => showToast(error.message));
    });
    threadList.appendChild(button);
  }
}

function renderMessages(messages, { forceScroll = false } = {}) {
  const shouldStick = forceScroll || isNearBottom(messageList);
  const visibleMessages = state.pendingMessage
    ? [...messages, state.pendingMessage]
    : [...messages];
  if (!visibleMessages.length) {
    messageList.className = "message-list empty";
    messageList.textContent = "这个线程还没有可显示的对话内容。";
    return;
  }

  messageList.className = "message-list";
  messageList.innerHTML = "";

  for (const message of visibleMessages) {
    const article = document.createElement("article");
    article.className = `message-row ${message.role}${message.pending ? " pending" : ""}`;
    article.innerHTML = `
      <div class="message-avatar ${message.role}">${escapeHtml(roleLabel(message.role).slice(0, 1))}</div>
      <div class="message-bubble">
        <div class="message-meta">
          <span class="message-role">${escapeHtml(roleLabel(message.role))}</span>
          <span>${escapeHtml(message.pending ? "发送中…" : timeStamp(message.timestamp))}</span>
        </div>
        <div class="message-body">${escapeHtml(message.text || "")}</div>
      </div>
    `;
    messageList.appendChild(article);
  }

  if (shouldStick) {
    messageList.scrollTop = messageList.scrollHeight;
  }
}

function renderSelectedThread() {
  const thread = state.selectedThread;
  if (!thread) {
    threadStateLabel.textContent = "等待选择线程";
    threadTitle.textContent = "选择左侧线程";
    threadActiveAt.textContent = "最后活动 --";
    composerStatus.textContent = "先选择一个线程";
    setComposerState(false);
    renderMessages([]);
    return;
  }

  threadStateLabel.textContent = thread.stateLabel || "等待中";
  threadTitle.textContent = thread.title || "未命名线程";
  threadActiveAt.textContent = `最后活动 ${relativeTime(thread.lastActiveAt || thread.updatedAt)}`;
  if (mobileThreadButton) {
    mobileThreadButton.textContent = `切换线程 · ${state.threads.length}`;
  }
  setComposerState(Boolean(thread.canSend));
}

async function loadThreads({ keepSelection = true } = {}) {
  const payload = await fetchJson("/api/chat-ui/threads");
  state.threads = payload.threads || [];
  syncBadge.textContent = `同步于 ${timeStamp(payload.serverTime || new Date().toISOString())}`;

  if (!keepSelection || !state.selectedThreadId || !state.threads.some((thread) => thread.id === state.selectedThreadId)) {
    state.selectedThreadId = state.threads[0]?.id || null;
  }

  renderThreads();
}

async function loadThread(threadId, { forceScroll = false } = {}) {
  if (!threadId) return;
  const payload = await fetchJson(`/api/chat-ui/threads/${encodeURIComponent(threadId)}`);
  state.selectedThread = payload.thread;
  state.selectedSession = payload.session;
  renderSelectedThread();
  renderMessages(payload.session?.messages || [], { forceScroll });
  renderThreads();
}

async function refreshAll({ forceScroll = false } = {}) {
  if (!state.authenticated || state.isLoading) return;
  state.isLoading = true;
  refreshButton.disabled = true;
  refreshButton.textContent = "同步中...";
  try {
    await loadThreads();
    if (state.selectedThreadId) {
      await loadThread(state.selectedThreadId, { forceScroll });
    } else {
      state.selectedThread = null;
      state.selectedSession = null;
      renderSelectedThread();
    }
    if (state.autopilotOpen) {
      await loadAutopilot();
    }
  } finally {
    state.isLoading = false;
    refreshButton.disabled = false;
    refreshButton.textContent = "刷新";
  }
}

async function sendMessage(message) {
  const threadId = state.selectedThreadId;
  const content = String(message || "").trim();
  if (!threadId || !content) return;

  state.isSending = true;
  state.pendingMessage = {
    role: "user",
    text: content,
    timestamp: new Date().toISOString(),
    pending: true,
  };
  renderSelectedThread();
  renderMessages(state.selectedSession?.messages || [], { forceScroll: true });

  try {
    await fetchJson(`/api/chat-ui/threads/${encodeURIComponent(threadId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: content }),
    });

    composerInput.value = "";
    showToast("消息已发给对应线程");
    await refreshAll({ forceScroll: true });
  } catch (error) {
    state.pendingMessage = null;
    renderMessages(state.selectedSession?.messages || [], { forceScroll: true });
    throw error;
  } finally {
    state.isSending = false;
    state.pendingMessage = null;
    renderSelectedThread();
  }
}

function startAutoSync() {
  if (state.syncTimer) {
    window.clearInterval(state.syncTimer);
  }
  state.syncTimer = window.setInterval(() => {
    refreshAll().catch((error) => {
      if (error.status === 401) {
        setAuthenticated(false);
        state.csrfToken = "";
        return;
      }
      console.error(error);
    });
  }, SYNC_INTERVAL_MS);
}

async function bootstrap() {
  try {
    const payload = await fetchJson("/api/chat-ui/session");
    if (!payload?.authenticated) {
      setAuthenticated(false);
      passwordInput.focus();
      return;
    }

    state.csrfToken = payload.csrfToken || "";
    setAuthenticated(true);
    await refreshAll({ forceScroll: true });
    await loadAutopilot();
    startAutoSync();
  } catch (error) {
    console.error(error);
    loginError.textContent = "无法连接本地服务，请稍后再试。";
    setAuthenticated(false);
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  loginButton.disabled = true;

  try {
    const payload = await fetchJson("/api/chat-ui/login", {
      method: "POST",
      body: JSON.stringify({ password: passwordInput.value }),
    });
    state.csrfToken = payload.csrfToken || "";
    passwordInput.value = "";
    setAuthenticated(true);
    await refreshAll({ forceScroll: true });
    await loadAutopilot();
    startAutoSync();
  } catch (error) {
    loginError.textContent = error.message || "登录失败";
    passwordInput.select();
  } finally {
    loginButton.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await fetchJson("/api/chat-ui/logout", {
      method: "POST",
      body: JSON.stringify({}),
    });
  } catch (error) {
    console.error(error);
  }
  window.clearInterval(state.syncTimer);
  state.syncTimer = null;
  state.csrfToken = "";
  state.selectedThreadId = null;
  state.selectedThread = null;
  state.selectedSession = null;
  setAuthenticated(false);
  renderSelectedThread();
  passwordInput.focus();
});

mobileThreadButton?.addEventListener("click", () => {
  if (appShell.classList.contains("sidebar-open")) {
    closeSidebarDrawer();
    return;
  }
  openSidebarDrawer();
});

sidebarCloseButton?.addEventListener("click", () => {
  closeSidebarDrawer();
});

sidebarBackdrop?.addEventListener("click", () => {
  closeSidebarDrawer();
});

refreshButton.addEventListener("click", () => {
  refreshAll().catch((error) => showToast(error.message));
});

autopilotToggleButton.addEventListener("click", () => {
  state.autopilotOpen = !state.autopilotOpen;
  renderAutopilotPanel();
  if (state.autopilotOpen && !state.autopilot) {
    loadAutopilot().catch((error) => showToast(error.message));
  }
});

autopilotEnabledInput.addEventListener("change", () => {
  autopilotStateText.textContent = autopilotEnabledInput.checked ? "开启" : "关闭";
});

autopilotSaveButton.addEventListener("click", () => {
  saveAutopilot().catch((error) => showToast(error.message));
});

autopilotRunButton.addEventListener("click", () => {
  saveAutopilot()
    .then(runAutopilotNow)
    .catch((error) => showToast(error.message));
});

sendButton.addEventListener("click", () => {
  sendMessage(composerInput.value).catch((error) => showToast(error.message));
});

quickButtons.forEach((button) => {
  button.addEventListener("click", () => {
    sendMessage(button.dataset.quickMessage || "").catch((error) => showToast(error.message));
  });
});

composerInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    sendMessage(composerInput.value).catch((error) => showToast(error.message));
  }
});

composerInput.addEventListener("focus", settleViewportAfterKeyboard);
composerInput.addEventListener("blur", () => {
  window.setTimeout(syncViewportHeight, 120);
});

window.addEventListener("resize", syncSidebarDrawer);
window.addEventListener("resize", syncViewportHeight);
window.visualViewport?.addEventListener("resize", syncViewportHeight);

syncViewportHeight();
bootstrap();
