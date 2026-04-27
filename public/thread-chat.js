const App = {
    state: {
        authenticated: false,
        csrfToken: '',
        threads: [],
        currentThreadId: null,
        autopilotConfig: null,
        refreshTimer: null,
        isSending: false
    },

    // 预设模式对应的配置片段
    presets: {
        'night-default': [
            { "condition": "idle", "match": "", "message": "继续" },
            { "condition": "idle", "match": "", "message": "进度？" },
            { "condition": "idle", "match": "", "message": "请拆下一步并继续执行，完成后说明结果。" }
        ],
        'progress-check': [
            { "condition": "idle", "match": "", "message": "进度？" },
            { "condition": "idle", "match": "", "message": "如果卡住，请说明卡点和下一步。" },
            { "condition": "idle", "match": "", "message": "请继续执行下一步。" }
        ],
        'step-runner': [
            { "condition": "idle", "match": "", "message": "请把剩余任务拆成下一小步，并直接执行。" },
            { "condition": "idle", "match": "", "message": "继续执行下一小步，完成后报告结果。" },
            { "condition": "idle", "match": "", "message": "如果发现问题，请先修复再继续。" }
        ]
    },

    async init() {
        this.cacheDOM();
        this.bindEvents();
        await this.checkSession();
        if (this.state.authenticated) {
            this.startPolling();
        }
    },

    cacheDOM() {
        this.dom = {
            loginOverlay: document.getElementById('login-overlay'),
            appContainer: document.getElementById('app-container'),
            loginPass: document.getElementById('login-password'),
            loginBtn: document.getElementById('login-btn'),
            threadList: document.getElementById('thread-list'),
            messagesContainer: document.getElementById('messages-container'),
            chatBody: document.getElementById('chat-body'),
            chatWelcome: document.getElementById('chat-welcome'),
            chatInput: document.getElementById('chat-input'),
            sendBtn: document.getElementById('send-btn'),
            apHeader: document.querySelector('.autopilot-header'),
            apStatusDot: document.getElementById('ap-status-dot'),
            apModeName: document.getElementById('ap-mode-name'),
            toggleApBtn: document.getElementById('toggle-ap-btn'),
            tickNowBtn: document.getElementById('tick-now-btn'),
            expandApBtn: document.getElementById('expand-ap-btn'),
            apAdvanced: document.getElementById('ap-advanced'),
            sidebar: document.getElementById('sidebar'),
            mobileMenuBtn: document.getElementById('mobile-menu-btn'),
            toastContainer: document.getElementById('toast-container'),
            refreshBtn: document.getElementById('refresh-btn'),
            logoutBtn: document.getElementById('logout-btn'),
            saveApBtn: document.getElementById('save-ap-btn'),
            presetSelect: document.getElementById('ap-preset-select'),
            intervalInput: document.getElementById('ap-interval'),
            maxThreadsInput: document.getElementById('ap-max-threads'),
            patternsInput: document.getElementById('ap-patterns')
        };
    },

    bindEvents() {
        this.dom.loginBtn.onclick = () => this.login();
        this.dom.sendBtn.onclick = () => this.sendMessage();
        this.dom.refreshBtn.onclick = () => this.refreshAll();
        this.dom.logoutBtn.onclick = () => this.logout();

        // 托管控制
        this.dom.expandApBtn.onclick = () => this.dom.apAdvanced.classList.toggle('hidden');
        this.dom.toggleApBtn.onclick = () => this.toggleAutopilot();
        this.dom.tickNowBtn.onclick = () => this.tickNow();
        this.dom.saveApBtn.onclick = () => this.saveAutopilotConfig();

        // 快捷回复
        document.querySelectorAll('.quick-btn[data-msg]').forEach(btn => {
            btn.onclick = () => {
                this.dom.chatInput.value = btn.dataset.msg;
                this.sendMessage();
            };
        });

        // 移动端菜单
        this.dom.mobileMenuBtn.onclick = () => this.dom.sidebar.classList.toggle('open');

        // 输入框回车
        this.dom.chatInput.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        };
    },

    async request(path, options = {}) {
        const url = this.withBase(path);
        const defaultHeaders = new Headers(options.headers || {});
        if (options.body && !defaultHeaders.has('Content-Type')) {
            defaultHeaders.set('Content-Type', 'application/json');
        }
        if (this.state.csrfToken) {
            defaultHeaders.set('x-thread-chat-csrf', this.state.csrfToken);
        }

        try {
            const res = await fetch(url, {
                credentials: 'same-origin',
                ...options,
                headers: defaultHeaders,
            });
            const text = await res.text();
            let data = {};
            if (text) {
                try {
                    data = JSON.parse(text);
                } catch {
                    data = { error: text };
                }
            }
            if (!res.ok) throw new Error(data.error || data.message || `请求失败 (${res.status})`);
            return data;
        } catch (err) {
            this.showToast(err.message);
            throw err;
        }
    },

    withBase(path) {
        if (path.startsWith('http')) return path;
        const pathname = window.location.pathname;
        const suffixes = ['/thread-chat', '/thread-chat.html'];
        const suffix = suffixes.find(item => pathname.endsWith(item));
        if (!suffix) return path;
        const prefix = pathname.slice(0, -suffix.length);
        return `${prefix === '/' ? '' : prefix}${path}`;
    },

    showToast(msg) {
        const t = document.createElement('div');
        t.className = 'toast';
        t.innerText = msg;
        this.dom.toastContainer.appendChild(t);
        setTimeout(() => t.remove(), 3000);
    },

    async checkSession() {
        const data = await this.request('/api/chat-ui/session');
        if (data.authenticated) {
            this.state.authenticated = true;
            this.state.csrfToken = data.csrfToken;
            this.dom.loginOverlay.classList.add('hidden');
            this.dom.appContainer.classList.remove('hidden');
            this.refreshAll();
        } else {
            this.dom.loginOverlay.classList.remove('hidden');
            this.dom.appContainer.classList.add('hidden');
        }
    },

    async login() {
        const password = this.dom.loginPass.value;
        const data = await this.request('/api/chat-ui/login', {
            method: 'POST',
            body: JSON.stringify({ password })
        });
        this.state.authenticated = true;
        this.state.csrfToken = data.csrfToken;
        this.dom.loginPass.value = '';
        this.dom.loginOverlay.classList.add('hidden');
        this.dom.appContainer.classList.remove('hidden');
        this.startPolling();
        this.refreshAll();
    },

    async logout() {
        await this.request('/api/chat-ui/logout', { method: 'POST', body: JSON.stringify({}) });
        location.reload();
    },

    async refreshAll() {
        await Promise.all([this.loadThreads(), this.loadAutopilot()]);
        if (this.state.currentThreadId) {
            this.loadThreadDetail(this.state.currentThreadId);
        }
    },

    startPolling() {
        if (this.state.refreshTimer) clearInterval(this.state.refreshTimer);
        this.state.refreshTimer = setInterval(() => this.refreshAll(), 60000);
    },

    async loadThreads() {
        const data = await this.request('/api/chat-ui/threads');
        this.state.threads = data.threads;
        this.renderThreadList();
    },

    renderThreadList() {
        this.dom.threadList.innerHTML = '';
        if (!this.state.threads.length) {
            const empty = document.createElement('div');
            empty.className = 'thread-empty';
            empty.textContent = '暂无线程';
            this.dom.threadList.appendChild(empty);
            return;
        }
        for (const thread of this.state.threads) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = `thread-item ${this.state.currentThreadId === thread.id ? 'active' : ''}`;
            item.innerHTML = `
                <div class="title"></div>
                <div class="preview"></div>
                <div class="meta">
                    <span></span>
                    <span></span>
                </div>
            `;
            item.querySelector('.title').textContent = thread.title || '未命名线程';
            item.querySelector('.preview').textContent = thread.preview || '';
            item.querySelector('.meta span:first-child').textContent = thread.stateLabel || '';
            item.querySelector('.meta span:last-child').textContent = this.formatTime(thread.updatedAt || thread.lastActiveAt);
            item.onclick = () => this.selectThread(thread.id);
            this.dom.threadList.appendChild(item);
        }
    },

    selectThread(id) {
        this.state.currentThreadId = id;
        this.renderThreadList();
        this.loadThreadDetail(id);
        this.dom.sidebar.classList.remove('open'); // 移动端自动收起
    },

    async loadThreadDetail(id) {
        const data = await this.request(`/api/chat-ui/threads/${id}`);
        this.renderMessages(data.session?.messages || []);
        this.dom.chatWelcome.classList.add('hidden');
    },

    renderMessages(messages) {
        this.dom.messagesContainer.innerHTML = '';
        for (const message of messages) {
            const row = document.createElement('div');
            row.className = `msg-row ${message.role || 'system'}`;
            const bubble = document.createElement('div');
            bubble.className = 'msg-bubble';
            bubble.textContent = message.text || '';
            const time = document.createElement('div');
            time.className = 'msg-time';
            time.textContent = this.formatTime(message.timestamp);
            row.appendChild(bubble);
            row.appendChild(time);
            this.dom.messagesContainer.appendChild(row);
        }
        this.dom.chatBody.scrollTop = this.dom.chatBody.scrollHeight;
    },

    async sendMessage() {
        const msg = this.dom.chatInput.value.trim();
        if (!msg || !this.state.currentThreadId || this.state.isSending) return;

        this.state.isSending = true;
        this.dom.sendBtn.disabled = true;
        this.dom.chatInput.value = '';
        try {
            await this.request(`/api/chat-ui/threads/${this.state.currentThreadId}/messages`, {
                method: 'POST',
                body: JSON.stringify({ message: msg })
            });
            await this.loadThreadDetail(this.state.currentThreadId);
        } finally {
            this.state.isSending = false;
            this.dom.sendBtn.disabled = false;
        }
    },

    async loadAutopilot() {
        const data = await this.request('/api/chat-ui/autopilot');
        this.state.autopilotConfig = data.config;
        this.renderAutopilotUI();
    },

    renderAutopilotUI() {
        const cfg = this.state.autopilotConfig;
        if (!cfg) return;
        const isActive = cfg.enabled;

        this.dom.apStatusDot.className = `status-dot ${isActive ? 'active' : ''}`;
        const currentScriptName = (cfg.scripts && cfg.scripts[0]) ? cfg.scripts[0].name : '无';
        this.dom.apModeName.innerText = isActive ? currentScriptName : '暂停中';
        this.dom.toggleApBtn.innerText = isActive ? '暂停托管' : '开启托管';

        // 填充高级面板
        this.dom.intervalInput.value = cfg.intervalMinutes || 15;
        this.dom.maxThreadsInput.value = cfg.maxThreadsPerTick || 2;
        this.dom.patternsInput.value = (cfg.completionPatterns || []).join(', ');
        if (cfg.scripts && cfg.scripts[0]) {
            this.dom.presetSelect.value = cfg.scripts[0].id;
        }
    },

    async toggleAutopilot() {
        const newEnabled = !this.state.autopilotConfig.enabled;
        this.state.autopilotConfig.enabled = newEnabled;
        await this.saveAutopilotConfig();
        this.showToast(newEnabled ? '托管已开启' : '托管已暂停');
    },

    async saveAutopilotConfig() {
        const presetId = this.dom.presetSelect.value;
        const presetName = this.dom.presetSelect.selectedOptions[0].text;

        const newConfig = {
            ...this.state.autopilotConfig,
            intervalMinutes: parseInt(this.dom.intervalInput.value, 10) || 15,
            maxThreadsPerTick: parseInt(this.dom.maxThreadsInput.value, 10) || 2,
            completionPatterns: this.dom.patternsInput.value.split(',').map(s => s.trim()).filter(Boolean),
            scripts: [{
                id: presetId,
                name: presetName,
                enabled: true,
                mode: "sequence",
                steps: this.presets[presetId]
            }]
        };

        const data = await this.request('/api/chat-ui/autopilot', {
            method: 'PUT',
            body: JSON.stringify({ config: newConfig })
        });
        this.state.autopilotConfig = data.config;
        this.renderAutopilotUI();
        this.showToast('托管设置已保存');
    },

    async tickNow() {
        if (!this.state.autopilotConfig.enabled) {
            this.state.autopilotConfig.enabled = true;
            await this.saveAutopilotConfig();
        }
        const data = await this.request('/api/chat-ui/autopilot/tick', { method: 'POST', body: JSON.stringify({}) });
        this.showToast(`执行完成：发送 ${data.sent?.length || 0} 条，跳过 ${data.skipped?.length || 0} 条`);
        this.refreshAll();
    },

    formatTime(value) {
        if (!value) return '--';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '--';
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },

    escapeHTML(str) {
        const p = document.createElement('p');
        p.textContent = str;
        return p.innerHTML;
    }
};

window.onload = () => App.init();
