#!/usr/bin/env node

import { program } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { spawn } from "node:child_process";

const PROFILES_DIR = path.join(os.homedir(), ".wrangler-profiles");
const CURRENT_PROFILE_FILE = path.join(PROFILES_DIR, ".current");

// Ensure profiles directory exists
if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

// Helper functions for output
const printSuccess = (msg: string) => console.log(chalk.green("✓") + " " + msg);
const printError = (msg: string) => console.log(chalk.red("✗") + " " + msg);
const printInfo = (msg: string) => console.log(chalk.blue("ℹ") + " " + msg);
const printWarn = (msg: string) => console.log(chalk.yellow("⚠") + " " + msg);

// Get list of profile names
function getProfiles(): string[] {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  return fs
    .readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith(".env"))
    .map((f) => f.replace(".env", ""));
}

// Get current profile name
function getCurrentProfile(): string | null {
  if (!fs.existsSync(CURRENT_PROFILE_FILE)) return null;
  return fs.readFileSync(CURRENT_PROFILE_FILE, "utf-8").trim();
}

// Get profile file path
function getProfilePath(name: string): string {
  return path.join(PROFILES_DIR, `${name}.env`);
}

// Parse profile env file
function parseProfile(name: string): Record<string, string> | null {
  const profilePath = getProfilePath(name);
  if (!fs.existsSync(profilePath)) return null;

  const content = fs.readFileSync(profilePath, "utf-8");
  const vars: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      vars[match[1]] = match[2];
    }
  }

  return vars;
}

// Prompt for input
async function prompt(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    if (hidden) {
      process.stdout.write(question);
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      stdin.setRawMode?.(true);

      let input = "";
      const onData = (char: Buffer) => {
        const c = char.toString();
        if (c === "\n" || c === "\r") {
          stdin.setRawMode?.(wasRaw ?? false);
          stdin.removeListener("data", onData);
          console.log();
          rl.close();
          resolve(input);
        } else if (c === "\u0003") {
          // Ctrl+C
          process.exit(1);
        } else if (c === "\u007f") {
          // Backspace
          input = input.slice(0, -1);
        } else {
          input += c;
        }
      };
      stdin.on("data", onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

// Commands

async function cmdList() {
  console.log("Available Wrangler profiles:");
  console.log("");

  const current = getCurrentProfile();
  const profiles = getProfiles();

  if (profiles.length === 0) {
    printWarn("No profiles found. Use 'add <name>' to create one.");
    return;
  }

  for (const name of profiles) {
    if (name === current) {
      console.log(chalk.green(`  → ${name}`) + " (active)");
    } else {
      console.log(`    ${name}`);
    }
  }
}

async function cmdAdd(name: string) {
  if (!name) {
    printError("Profile name required");
    console.log("Usage: wrangler-profiles add <profile-name>");
    process.exit(1);
  }

  const profilePath = getProfilePath(name);

  if (fs.existsSync(profilePath)) {
    printError(`Profile '${name}' already exists`);
    process.exit(1);
  }

  console.log(`Creating profile: ${name}`);
  console.log("");

  const accountId = await prompt("Cloudflare Account ID: ");
  const apiToken = await prompt("Cloudflare API Token: ", true);

  if (!accountId || !apiToken) {
    printError("Account ID and API Token are required");
    process.exit(1);
  }

  const content = `# Wrangler profile: ${name}
# Created: ${new Date().toISOString()}

CLOUDFLARE_ACCOUNT_ID=${accountId}
CLOUDFLARE_API_TOKEN=${apiToken}
`;

  fs.writeFileSync(profilePath, content, { mode: 0o600 });

  printSuccess(`Profile '${name}' created`);
  printInfo(`Use 'wrangler-profiles use ${name}' to switch to this profile`);
}

async function cmdUse(name: string) {
  if (!name) {
    printError("Profile name required");
    console.log("Usage: wrangler-profiles use <profile-name>");
    process.exit(1);
  }

  const profilePath = getProfilePath(name);

  if (!fs.existsSync(profilePath)) {
    printError(`Profile '${name}' not found`);
    console.log("Available profiles:");
    await cmdList();
    process.exit(1);
  }

  fs.writeFileSync(CURRENT_PROFILE_FILE, name);

  printSuccess(`Switched to profile: ${name}`);
  printInfo("Run 'source $(wrangler-profiles env)' to load into shell");
  printInfo("Or use 'wrangler-profiles deploy <env>' to deploy with this profile");
}

async function cmdCurrent() {
  const current = getCurrentProfile();

  if (!current) {
    printWarn("No profile selected");
    process.exit(1);
  }

  const profilePath = getProfilePath(current);

  if (!fs.existsSync(profilePath)) {
    printError(`Current profile '${current}' not found`);
    process.exit(1);
  }

  console.log(`Current profile: ${current}`);

  const vars = parseProfile(current);
  if (vars?.CLOUDFLARE_ACCOUNT_ID) {
    console.log(`Account ID: ${vars.CLOUDFLARE_ACCOUNT_ID}`);
  }
}

async function cmdEnv() {
  const current = getCurrentProfile();

  if (!current) {
    printError("No profile selected");
    process.exit(1);
  }

  console.log(getProfilePath(current));
}

async function cmdDeploy(env?: string) {
  const current = getCurrentProfile();

  if (!current) {
    printError("No profile selected. Use 'wrangler-profiles use <name>' first.");
    process.exit(1);
  }

  const profilePath = getProfilePath(current);

  if (!fs.existsSync(profilePath)) {
    printError(`Profile '${current}' not found`);
    process.exit(1);
  }

  printInfo(`Deploying with profile: ${current}`);

  const vars = parseProfile(current);
  if (!vars) {
    printError("Failed to parse profile");
    process.exit(1);
  }

  const args = env ? ["deploy", "--env", env] : ["deploy"];

  const child = spawn("wrangler", args, {
    stdio: "inherit",
    env: { ...process.env, ...vars },
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

async function cmdRun(args: string[]) {
  const current = getCurrentProfile();

  if (!current) {
    printError("No profile selected. Use 'wrangler-profiles use <name>' first.");
    process.exit(1);
  }

  const profilePath = getProfilePath(current);

  if (!fs.existsSync(profilePath)) {
    printError(`Profile '${current}' not found`);
    process.exit(1);
  }

  printInfo(`Running with profile: ${current}`);

  const vars = parseProfile(current);
  if (!vars) {
    printError("Failed to parse profile");
    process.exit(1);
  }

  const child = spawn("wrangler", args, {
    stdio: "inherit",
    env: { ...process.env, ...vars },
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

async function cmdRemove(name: string) {
  if (!name) {
    printError("Profile name required");
    console.log("Usage: wrangler-profiles remove <profile-name>");
    process.exit(1);
  }

  const profilePath = getProfilePath(name);

  if (!fs.existsSync(profilePath)) {
    printError(`Profile '${name}' not found`);
    process.exit(1);
  }

  const confirm = await prompt(`Are you sure you want to remove profile '${name}'? [y/N] `);
  if (confirm.toLowerCase() !== "y") {
    console.log("Cancelled");
    return;
  }

  fs.unlinkSync(profilePath);

  // Clear current if it was this profile
  const current = getCurrentProfile();
  if (current === name) {
    fs.unlinkSync(CURRENT_PROFILE_FILE);
  }

  printSuccess(`Profile '${name}' removed`);
}

// CLI setup
program
  .name("wrangler-profiles")
  .description("Manage multiple Cloudflare accounts for Wrangler deployments")
  .version("1.0.0");

program
  .command("list")
  .description("List all profiles")
  .action(() => cmdList());

program
  .command("add <name>")
  .description("Add a new profile (prompts for credentials)")
  .action((name) => cmdAdd(name));

program
  .command("use <name>")
  .description("Switch to a profile")
  .action((name) => cmdUse(name));

program
  .command("current")
  .description("Show current profile")
  .action(() => cmdCurrent());

program
  .command("env")
  .description("Output path to current profile env file (for sourcing)")
  .action(() => cmdEnv());

program
  .command("deploy [env]")
  .description("Deploy with current profile (optional wrangler env)")
  .action((env) => cmdDeploy(env));

program
  .command("run <args...>")
  .description("Run any wrangler command with current profile")
  .action((args) => cmdRun(args));

program
  .command("remove <name>")
  .description("Remove a profile")
  .action((name) => cmdRemove(name));

program.parse();
