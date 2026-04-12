#!/usr/bin/env node

import { pbkdf2Sync, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_FILE = path.join(ROOT_DIR, "config", "thread_chat_auth.json");
const DEFAULT_ITERATIONS = 210000;
const DEFAULT_KEY_LENGTH = 32;
const DEFAULT_DIGEST = "sha256";

function printHelp() {
  console.log(`
Usage:
  node scripts/generate-thread-chat-auth.mjs "YourStrongPassword"

Optional:
  THREAD_CHAT_PASSWORD=YourStrongPassword node scripts/generate-thread-chat-auth.mjs
`.trim());
}

function readPassword(argv) {
  const cliValue = String(argv[0] || "").trim();
  if (cliValue) return cliValue;
  return String(process.env.THREAD_CHAT_PASSWORD || "").trim();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const password = readPassword(args);
  if (!password) {
    printHelp();
    throw new Error("Password is required");
  }

  const salt = randomBytes(16);
  const passwordHash = pbkdf2Sync(
    password,
    salt,
    DEFAULT_ITERATIONS,
    DEFAULT_KEY_LENGTH,
    DEFAULT_DIGEST,
  ).toString("hex");

  const payload = {
    salt: salt.toString("hex"),
    passwordHash,
    iterations: DEFAULT_ITERATIONS,
    keylen: DEFAULT_KEY_LENGTH,
    digest: DEFAULT_DIGEST,
  };

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Created ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
