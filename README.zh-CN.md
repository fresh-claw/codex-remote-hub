# Codex Remote Hub

让你远程查看本机 Codex 任务，并随时发一句话继续推进。

| 功能 | 说明 |
| --- | --- |
| 进度查看 | 统一查看多个任务现在做到哪里 |
| 消息续推 | 给指定任务发送“继续”或自定义消息 |
| 任务切换 | 在不同任务之间快速切换 |
| 远程接入 | 用网页或 Matrix 在外部继续推进工作 |
| 停滞提醒 | 对长时间没动静的任务做提醒 |

## 这是什么

Codex Remote Hub 是一个给本机 Codex 用的远程任务台。

当一台电脑同时跑多个 Codex 任务时，真正麻烦的往往不是启动任务，而是后面的管理。你很难随时知道哪个任务还在推进，哪个任务已经停住，哪个任务只差一句“继续”就能往下走。这个项目就是为这个问题准备的。

它把本机正在运行的 Codex 任务整理成一个统一入口，让你可以在电脑、网页或聊天入口里查看进展、切换任务、发送新消息，把停住的工作重新推起来。

## 适合什么场景

- 一台机器同时跑多个 Codex 任务
- 人不在电脑前，也想知道任务做到哪里
- 想远程补一句“继续”或“进度？”
- 想把多个任务整理成更容易管理的入口

## 你需要先准备什么

在开始前，建议先满足这些条件：

1. 本机已经能正常运行 Codex
2. 本机已经有正在使用的 Codex 任务
3. 电脑里已安装 Node.js 20 或更高版本
4. 如果要远程对话，准备一个 Matrix 账号
5. 如果要安全地在外部访问，建议准备私有网络或登录保护

## 安装方式

先把项目拉到本机：

```bash
git clone <your-repo-url>
cd codex-remote-hub
```

先生成登录密码配置：

```bash
npm run auth:init -- "UseAReallyStrongPassword"
```

## 本地启动

启动服务：

```bash
npm start
```

打开页面：

```text
http://127.0.0.1:8787/thread-chat
```

这时你就可以在本机浏览器里看到任务列表，并进入单个任务查看内容。

## 怎么使用

最常见的使用方式只有三步：

1. 打开任务页，看当前有哪些任务
2. 进入某个任务，查看最近内容
3. 发一句“继续”或自定义消息，让这个任务继续往下做

如果你同时跑多个任务，也可以在页面里来回切换，分别查看它们的状态。

## 远程使用

这个项目支持两种方式：

### 方式一：网页访问

服务默认只在本机开放。远程使用时，建议先加登录保护，再放到私有网络或受控入口后面。这样你在手机上也能打开任务页，远程查看和发消息。

### 方式二：Matrix 对话

如果你想像聊天一样管理任务，可以接入 Matrix。这样每个任务都可以对应到远程对话入口。

先复制示例配置：

```bash
cp examples/matrix_bridge.example.json config/matrix_bridge.json
```

改好 `config/matrix_bridge.json` 后启动：

```bash
npm run bridge
```

## 停滞提醒

如果你需要对停住的任务做自动提醒，可以先复制示例配置：

```bash
cp examples/thread_nudger.example.json config/thread_nudger.json
```

然后启动：

```bash
npm run nudger
```

## 目录结构

```text
server.mjs                 网页服务
matrix_bridge.mjs          Matrix 桥接
thread_nudger.mjs          停滞提醒
public/                    页面文件
examples/                  示例配置
scripts/                   辅助脚本
config/                    本地配置
state/                     本地运行数据
```

## 安全边界

建议这样使用：

- 服务默认只在本机开放
- 远程访问前先加登录保护
- 不要把真实配置和运行数据提交到仓库
- 不要公开账号、密码、Token 和会话数据
- 如果要外部访问，优先放在私有网络里

## English README

英文说明见 [README.md](./README.md)。
