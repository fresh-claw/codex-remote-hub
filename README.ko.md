# Codex Remote Hub

Run Codex on your Mac. Control it from anywhere.

| Feature | What it does |
| --- | --- |
| Progress View | See every Codex job in one place |
| Message Push | Send "continue" or any message |
| Job Switcher | Move between jobs fast |
| Remote Access | Use it from a browser or Matrix |
| Stall Alerts | Find jobs that stopped moving |

## What this is

Codex Remote Hub is a small web control panel for local Codex jobs.

It helps people who run many Codex jobs on one computer. You can see status, read recent messages, and send a follow-up from another device.

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
