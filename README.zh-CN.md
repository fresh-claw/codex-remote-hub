# Codex Remote Hub

Codex 在本机运行，你在外部也能查看和发送消息。

| 功能 | 说明 |
| --- | --- |
| 进度查看 | 集中查看每个 Codex 任务 |
| 消息发送 | 给指定任务发送“继续”或自定义消息 |
| 任务切换 | 快速切换不同任务 |
| 远程接入 | 通过网页或 Matrix 使用 |
| 停滞提醒 | 找到长时间没变化的任务 |

## 这是什么

Codex Remote Hub 是一个给本机 Codex 用的网页控制台。

它适合同时运行多个 Codex 任务的人。页面会显示任务状态、最近消息和输入框。任务停住时，你可以发一句“继续”或其他指令，让任务继续推进。

它不是替代 Codex，而是给 Codex 补一个更清楚的远程控制入口。

## 安装

```bash
git clone https://github.com/fresh-claw/codex-remote-hub.git
cd codex-remote-hub
npm install
npm run auth:init -- "UseAReallyStrongPassword"
npm start
```

打开：

```text
http://127.0.0.1:8787/thread-chat
```

## 使用

打开页面，选择一个 Codex 任务，查看最近消息，然后发送“继续”“进度？”或自定义指令。

## 远程访问

远程使用时，建议放在私有网络或受保护入口后面。默认保持本机访问，不要把页面直接公开到互联网。

## 安全

- 不要公开真实配置
- 不要公开密码、Token、会话数据
- 使用强密码
- 远程访问优先使用私有网络
