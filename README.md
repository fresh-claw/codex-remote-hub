# Codex Remote Hub

Run Codex on your Mac. Control it from anywhere.

| Feature | What it does |
| --- | --- |
| Progress View | See every Codex job in one place |
| Message Push | Send "continue" or any message to one job |
| Job Switcher | Move between jobs fast |
| Remote Access | Use it from a browser or Matrix |
| Stall Alerts | Find jobs that stopped moving |

## What this is

Codex Remote Hub is a small web control panel for local Codex jobs.

It is for people who run many Codex jobs on one computer. It shows job status, recent messages, and a reply box for each job. When a job stops, you can send a short follow-up and keep the work moving.

It does not replace Codex. It gives Codex a clearer remote work panel.

## When it is useful

- You run several Codex jobs on one Mac
- You want to check progress from your phone
- You need a quick way to send "continue"
- You want one clean page for many jobs

## Install

```bash
git clone https://github.com/fresh-claw/codex-remote-hub.git
cd codex-remote-hub
npm install
npm run auth:init -- "UseAReallyStrongPassword"
npm start
```

Open:

```text
http://127.0.0.1:8787/thread-chat
```

## Use

Open the page, choose a Codex job, read the latest messages, and send a follow-up message. Common messages are "continue", "progress?", or any instruction you want that job to follow.

## Remote access

For remote use, put the page behind a private network or another protected entry point. Keep the service local by default. Do not expose the page to the open internet without access control.

## Matrix

Matrix can turn each Codex job into a chat-style room.

```bash
cp examples/matrix_bridge.example.json config/matrix_bridge.json
npm run bridge
```

## Stall alerts

The nudger can find jobs that have stopped moving.

```bash
cp examples/thread_nudger.example.json config/thread_nudger.json
npm run nudger
```

## Security

- Keep real config files private
- Do not publish passwords, tokens, or session data
- Use a strong page password
- Prefer a private network for remote access

## Language

- [中文](README.zh-CN.md)
- [日本語](README.ja.md)
- [한국어](README.ko.md)
- [Español](README.es.md)
- [Français](README.fr.md)
- [Deutsch](README.de.md)
