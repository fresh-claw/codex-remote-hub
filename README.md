# Codex Remote Hub

See your local Codex jobs remotely and keep them moving with one follow-up message.

| Feature | What it does |
| --- | --- |
| Progress View | See where multiple jobs are right now |
| Message Push | Send “continue” or any custom follow-up message |
| Job Switcher | Move between jobs quickly |
| Remote Access | Continue local work from the web or Matrix |
| Stall Alerts | Notice jobs that have stopped moving |

## What this is

Codex Remote Hub is a remote workspace for local Codex jobs.

When one machine is running multiple Codex jobs, the hard part is usually not starting them. The hard part is managing them after that. It becomes difficult to see which job is still moving, which one has stalled, and which one only needs a quick follow-up message to continue. This project is built for that exact situation.

It turns local Codex jobs into one workspace where you can check progress, switch between jobs, send follow-up messages, and keep stalled work moving again.

## When it is useful

- You run multiple Codex jobs on one machine
- You want to check progress when you are away from the computer
- You want to send a quick “continue” or “progress?” message remotely
- You want one cleaner entry point for managing many jobs

## What you need first

Before using it, make sure:

1. Codex already runs correctly on your machine
2. You already have local Codex jobs to manage
3. Node.js 20 or above is installed
4. If you want chat-based remote access, prepare a Matrix account
5. If you want external access, use authentication or a private network

## Installation

Clone the project:

```bash
git clone <your-repo-url>
cd codex-remote-hub
```

Create the login password file:

```bash
npm run auth:init -- "UseAReallyStrongPassword"
```

## Local run

Start the web service:

```bash
npm start
```

Open:

```text
http://127.0.0.1:8787/thread-chat
```

You can now see local jobs in the browser and open one job to read or continue it.

## How to use it

The common flow is simple:

1. Open the task page and see active jobs
2. Open one job and read the latest messages
3. Send “continue” or any custom follow-up message

If you have several jobs running at the same time, you can switch between them and manage them one by one.

## Remote use

This project supports two remote paths:

### Option 1: Web access

Keep the service local by default, then put it behind authentication and a private entry point. This lets you open the task page on your phone and continue local work remotely.

### Option 2: Matrix chat

If you prefer a chat-style workflow, connect it to Matrix. This gives you a remote conversation entry for local jobs.

Copy the example config:

```bash
cp examples/matrix_bridge.example.json config/matrix_bridge.json
```

Update the values in `config/matrix_bridge.json`, then start the bridge:

```bash
npm run bridge
```

## Stall alerts

If you want automatic reminders for stalled jobs, copy the example nudger config:

```bash
cp examples/thread_nudger.example.json config/thread_nudger.json
```

Then start it:

```bash
npm run nudger
```

## Project structure

```text
server.mjs                 web service
matrix_bridge.mjs          Matrix bridge
thread_nudger.mjs          stalled-job nudger
public/                    web UI
examples/                  config templates
scripts/                   helper scripts
config/                    local config files
state/                     local runtime state
```

## Security boundary

Recommended usage:

- keep the service local by default
- add authentication before any remote use
- never publish real config or runtime data
- never expose passwords, tokens, or session data
- prefer a private network for external access

## Chinese README

For Chinese documentation, see [README.zh-CN.md](./README.zh-CN.md).
