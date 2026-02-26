#!/usr/bin/env node

import { program } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";

const PROFILES_DIR = path.join(os.homedir(), ".wrangler-profiles");
const CURRENT_PROFILE_FILE = path.join(PROFILES_DIR, ".current");
const WRANGLER_CONFIG_DIR = path.join(os.homedir(), ".wrangler", "config");
const WRANGLER_DEFAULT_TOML = path.join(WRANGLER_CONFIG_DIR, "default.toml");

// Ensure profiles directory exists
if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

// Profile types
interface Profile {
  name: string;
  type: "oauth" | "api_token";
  account_id: string;
  api_token?: string; // Only for api_token type
  created: string;
}

// Helper functions for output
const printSuccess = (msg: string) => console.log(chalk.green("✓") + " " + msg);
const printError = (msg: string) => console.log(chalk.red("✗") + " " + msg);
const printInfo = (msg: string) => console.log(chalk.blue("ℹ") + " " + msg);
const printWarn = (msg: string) => console.log(chalk.yellow("⚠") + " " + msg);

// File paths for a profile
function getProfileJsonPath(name: string): string {
  return path.join(PROFILES_DIR, `${name}.json`);
}

function getProfileOAuthPath(name: string): string {
  return path.join(PROFILES_DIR, `${name}.oauth.toml`);
}

function getProfileEnvPath(name: string): string {
  return path.join(PROFILES_DIR, `${name}.env`);
}

// Load profile metadata
function loadProfile(name: string): Profile | null {
  const jsonPath = getProfileJsonPath(name);
  if (fs.existsSync(jsonPath)) {
    return JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  }

  // Migration: check for legacy .env file
  const envPath = getProfileEnvPath(name);
  if (fs.existsSync(envPath)) {
    return migrateLegacyProfile(name);
  }

  return null;
}

// Save profile metadata
function saveProfile(profile: Profile): void {
  const jsonPath = getProfileJsonPath(profile.name);
  fs.writeFileSync(jsonPath, JSON.stringify(profile, null, 2), { mode: 0o600 });
}

// Migrate legacy .env profile to new format
function migrateLegacyProfile(name: string): Profile {
  const envPath = getProfileEnvPath(name);
  const content = fs.readFileSync(envPath, "utf-8");

  let accountId = "";
  let apiToken = "";

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("CLOUDFLARE_ACCOUNT_ID=")) {
      accountId = trimmed.replace("CLOUDFLARE_ACCOUNT_ID=", "");
    } else if (trimmed.startsWith("CLOUDFLARE_API_TOKEN=")) {
      apiToken = trimmed.replace("CLOUDFLARE_API_TOKEN=", "");
    }
  }

  const profile: Profile = {
    name,
    type: "api_token",
    account_id: accountId,
    api_token: apiToken,
    created: new Date().toISOString(),
  };

  saveProfile(profile);
  printInfo(`Migrated legacy profile '${name}' to new format`);

  return profile;
}

// Get list of profile names
function getProfiles(): string[] {
  if (!fs.existsSync(PROFILES_DIR)) return [];

  const files = fs.readdirSync(PROFILES_DIR);
  const profiles = new Set<string>();

  for (const f of files) {
    if (f.endsWith(".json")) {
      profiles.add(f.replace(".json", ""));
    } else if (f.endsWith(".env") && !f.startsWith(".")) {
      // Legacy profile
      profiles.add(f.replace(".env", ""));
    }
  }

  return Array.from(profiles).sort();
}

// Get current profile name
function getCurrentProfile(): string | null {
  if (!fs.existsSync(CURRENT_PROFILE_FILE)) return null;
  return fs.readFileSync(CURRENT_PROFILE_FILE, "utf-8").trim();
}

// Check if profile exists
function profileExists(name: string): boolean {
  return (
    fs.existsSync(getProfileJsonPath(name)) ||
    fs.existsSync(getProfileEnvPath(name))
  );
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
          process.exit(1);
        } else if (c === "\u007f") {
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

// Run wrangler login and wait for completion
async function runWranglerLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("wrangler", ["login"], {
      stdio: "inherit",
    });

    child.on("close", (code) => {
      resolve(code === 0);
    });

    child.on("error", () => {
      resolve(false);
    });
  });
}

// Get account info from wrangler whoami
function getWranglerWhoami(): { accountId: string; email: string } | null {
  try {
    const result = spawnSync("wrangler", ["whoami"], {
      encoding: "utf-8",
      timeout: 30000,
    });

    if (result.status !== 0) return null;

    const output = result.stdout;

    // Parse account ID from output like:
    // Account Name | Account ID
    // Some Account | abc123def456
    const lines = output.split("\n");
    for (const line of lines) {
      // Look for line with account ID (32 char hex string)
      const match = line.match(/\|\s*([a-f0-9]{32})\s*$/i);
      if (match) {
        return { accountId: match[1], email: "" };
      }
    }

    return null;
  } catch {
    return null;
  }
}

// Activate OAuth profile by copying to wrangler config
function activateOAuthProfile(name: string): boolean {
  const oauthPath = getProfileOAuthPath(name);

  if (!fs.existsSync(oauthPath)) {
    printError(`OAuth config for profile '${name}' not found`);
    return false;
  }

  // Ensure wrangler config directory exists
  if (!fs.existsSync(WRANGLER_CONFIG_DIR)) {
    fs.mkdirSync(WRANGLER_CONFIG_DIR, { recursive: true });
  }

  // Copy profile OAuth config to wrangler default.toml
  fs.copyFileSync(oauthPath, WRANGLER_DEFAULT_TOML);
  fs.chmodSync(WRANGLER_DEFAULT_TOML, 0o600);

  return true;
}

// Commands

async function cmdList() {
  console.log("Available Wrangler profiles:");
  console.log("");

  const current = getCurrentProfile();
  const profiles = getProfiles();

  if (profiles.length === 0) {
    printWarn("No profiles found. Use 'add <name> --oauth' or 'add <name> --token' to create one.");
    return;
  }

  for (const name of profiles) {
    const profile = loadProfile(name);
    const typeLabel = profile?.type === "oauth" ? chalk.cyan("oauth") : chalk.yellow("token");

    if (name === current) {
      console.log(chalk.green(`  → ${name}`) + ` [${typeLabel}] (active)`);
    } else {
      console.log(`    ${name} [${typeLabel}]`);
    }
  }
}

async function cmdAdd(name: string, options: { oauth?: boolean; token?: boolean }) {
  if (!name) {
    printError("Profile name required");
    console.log("Usage: wrangler-profiles add <name> --oauth|--token");
    process.exit(1);
  }

  if (profileExists(name)) {
    printError(`Profile '${name}' already exists`);
    process.exit(1);
  }

  // Determine auth type
  let authType: "oauth" | "api_token";

  if (options.oauth) {
    authType = "oauth";
  } else if (options.token) {
    authType = "api_token";
  } else {
    // Prompt user to choose
    console.log("Select authentication method:");
    console.log("  1. OAuth (browser login) - recommended");
    console.log("  2. API Token (manual entry)");
    const choice = await prompt("Choice [1/2]: ");

    if (choice === "2") {
      authType = "api_token";
    } else {
      authType = "oauth";
    }
  }

  if (authType === "oauth") {
    await addOAuthProfile(name);
  } else {
    await addTokenProfile(name);
  }
}

async function addOAuthProfile(name: string) {
  console.log(`\nCreating OAuth profile: ${name}`);
  printInfo("Opening browser for Cloudflare login...");
  console.log("");

  const success = await runWranglerLogin();

  if (!success) {
    printError("Login failed or was cancelled");
    process.exit(1);
  }

  // Check if wrangler created the config
  if (!fs.existsSync(WRANGLER_DEFAULT_TOML)) {
    printError("Login completed but no OAuth tokens found");
    printInfo("Expected tokens at: " + WRANGLER_DEFAULT_TOML);
    process.exit(1);
  }

  // Copy OAuth tokens to profile storage
  const oauthPath = getProfileOAuthPath(name);
  fs.copyFileSync(WRANGLER_DEFAULT_TOML, oauthPath);
  fs.chmodSync(oauthPath, 0o600);

  // Try to get account ID from wrangler whoami
  printInfo("Fetching account information...");
  const whoami = getWranglerWhoami();

  let accountId: string;
  if (whoami?.accountId) {
    accountId = whoami.accountId;
    printInfo(`Detected Account ID: ${accountId}`);
  } else {
    // Prompt for account ID
    accountId = await prompt("Cloudflare Account ID (from dashboard): ");
    if (!accountId) {
      printError("Account ID is required");
      fs.unlinkSync(oauthPath);
      process.exit(1);
    }
  }

  // Save profile metadata
  const profile: Profile = {
    name,
    type: "oauth",
    account_id: accountId,
    created: new Date().toISOString(),
  };

  saveProfile(profile);

  console.log("");
  printSuccess(`Profile '${name}' created (OAuth)`);
  printInfo(`Use 'wrangler-profiles use ${name}' to switch to this profile`);
}

async function addTokenProfile(name: string) {
  console.log(`\nCreating API token profile: ${name}`);
  console.log("");

  const accountId = await prompt("Cloudflare Account ID: ");
  const apiToken = await prompt("Cloudflare API Token: ", true);

  if (!accountId || !apiToken) {
    printError("Account ID and API Token are required");
    process.exit(1);
  }

  // Save profile metadata
  const profile: Profile = {
    name,
    type: "api_token",
    account_id: accountId,
    api_token: apiToken,
    created: new Date().toISOString(),
  };

  saveProfile(profile);

  // Also save .env for backward compatibility with env command
  const envContent = `# Wrangler profile: ${name}
# Created: ${new Date().toISOString()}

CLOUDFLARE_ACCOUNT_ID=${accountId}
CLOUDFLARE_API_TOKEN=${apiToken}
`;
  fs.writeFileSync(getProfileEnvPath(name), envContent, { mode: 0o600 });

  console.log("");
  printSuccess(`Profile '${name}' created (API Token)`);
  printInfo(`Use 'wrangler-profiles use ${name}' to switch to this profile`);
}

async function cmdUse(name: string) {
  if (!name) {
    printError("Profile name required");
    console.log("Usage: wrangler-profiles use <profile-name>");
    process.exit(1);
  }

  const profile = loadProfile(name);

  if (!profile) {
    printError(`Profile '${name}' not found`);
    console.log("Available profiles:");
    await cmdList();
    process.exit(1);
  }

  // For OAuth profiles, activate by copying to wrangler config
  if (profile.type === "oauth") {
    if (!activateOAuthProfile(name)) {
      process.exit(1);
    }
    printSuccess(`Activated OAuth config for profile: ${name}`);
  }

  fs.writeFileSync(CURRENT_PROFILE_FILE, name);

  printSuccess(`Switched to profile: ${name} (${profile.type === "oauth" ? "OAuth" : "API Token"})`);

  if (profile.type === "api_token") {
    printInfo("Run 'source $(wrangler-profiles env)' to load into shell");
  }
  printInfo("Or use 'wrangler-profiles deploy' / 'wrangler-profiles run' commands");
}

async function cmdCurrent() {
  const currentName = getCurrentProfile();

  if (!currentName) {
    printWarn("No profile selected");
    process.exit(1);
  }

  const profile = loadProfile(currentName);

  if (!profile) {
    printError(`Current profile '${currentName}' not found`);
    process.exit(1);
  }

  console.log(`Current profile: ${currentName}`);
  console.log(`Type: ${profile.type === "oauth" ? "OAuth" : "API Token"}`);
  console.log(`Account ID: ${profile.account_id}`);
}

async function cmdEnv() {
  const currentName = getCurrentProfile();

  if (!currentName) {
    printError("No profile selected");
    process.exit(1);
  }

  const profile = loadProfile(currentName);

  if (!profile) {
    printError(`Profile '${currentName}' not found`);
    process.exit(1);
  }

  if (profile.type === "oauth") {
    printWarn("OAuth profiles don't use env files - credentials are in ~/.wrangler/config/default.toml");
    process.exit(1);
  }

  // For API token profiles, output the env file path
  const envPath = getProfileEnvPath(currentName);
  if (fs.existsSync(envPath)) {
    console.log(envPath);
  } else {
    // Generate env file if it doesn't exist
    const envContent = `CLOUDFLARE_ACCOUNT_ID=${profile.account_id}
CLOUDFLARE_API_TOKEN=${profile.api_token}
`;
    fs.writeFileSync(envPath, envContent, { mode: 0o600 });
    console.log(envPath);
  }
}

async function cmdDeploy(env?: string) {
  const currentName = getCurrentProfile();

  if (!currentName) {
    printError("No profile selected. Use 'wrangler-profiles use <name>' first.");
    process.exit(1);
  }

  const profile = loadProfile(currentName);

  if (!profile) {
    printError(`Profile '${currentName}' not found`);
    process.exit(1);
  }

  printInfo(`Deploying with profile: ${currentName} (${profile.type === "oauth" ? "OAuth" : "API Token"})`);

  const args = env ? ["deploy", "--env", env] : ["deploy"];

  // Build environment
  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    CLOUDFLARE_ACCOUNT_ID: profile.account_id,
  };

  // For API token profiles, also set the token
  if (profile.type === "api_token" && profile.api_token) {
    childEnv.CLOUDFLARE_API_TOKEN = profile.api_token;
  }

  const child = spawn("wrangler", args, {
    stdio: "inherit",
    env: childEnv,
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

async function cmdRun(args: string[]) {
  const currentName = getCurrentProfile();

  if (!currentName) {
    printError("No profile selected. Use 'wrangler-profiles use <name>' first.");
    process.exit(1);
  }

  const profile = loadProfile(currentName);

  if (!profile) {
    printError(`Profile '${currentName}' not found`);
    process.exit(1);
  }

  printInfo(`Running with profile: ${currentName} (${profile.type === "oauth" ? "OAuth" : "API Token"})`);

  // Build environment
  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    CLOUDFLARE_ACCOUNT_ID: profile.account_id,
  };

  // For API token profiles, also set the token
  if (profile.type === "api_token" && profile.api_token) {
    childEnv.CLOUDFLARE_API_TOKEN = profile.api_token;
  }

  const child = spawn("wrangler", args, {
    stdio: "inherit",
    env: childEnv,
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

async function cmdLogin(name: string) {
  if (!name) {
    printError("Profile name required");
    console.log("Usage: wrangler-profiles login <profile-name>");
    process.exit(1);
  }

  const profile = loadProfile(name);

  if (!profile) {
    printError(`Profile '${name}' not found`);
    process.exit(1);
  }

  if (profile.type !== "oauth") {
    printError(`Profile '${name}' is not an OAuth profile`);
    printInfo("Use 'wrangler-profiles add <name> --oauth' to create an OAuth profile");
    process.exit(1);
  }

  console.log(`\nRe-authenticating OAuth profile: ${name}`);
  printInfo("Opening browser for Cloudflare login...");
  console.log("");

  const success = await runWranglerLogin();

  if (!success) {
    printError("Login failed or was cancelled");
    process.exit(1);
  }

  // Check if wrangler created the config
  if (!fs.existsSync(WRANGLER_DEFAULT_TOML)) {
    printError("Login completed but no OAuth tokens found");
    process.exit(1);
  }

  // Copy OAuth tokens to profile storage
  const oauthPath = getProfileOAuthPath(name);
  fs.copyFileSync(WRANGLER_DEFAULT_TOML, oauthPath);
  fs.chmodSync(oauthPath, 0o600);

  console.log("");
  printSuccess(`Profile '${name}' re-authenticated`);
}

async function cmdRemove(name: string) {
  if (!name) {
    printError("Profile name required");
    console.log("Usage: wrangler-profiles remove <profile-name>");
    process.exit(1);
  }

  if (!profileExists(name)) {
    printError(`Profile '${name}' not found`);
    process.exit(1);
  }

  const confirm = await prompt(`Are you sure you want to remove profile '${name}'? [y/N] `);
  if (confirm.toLowerCase() !== "y") {
    console.log("Cancelled");
    return;
  }

  // Remove all profile files
  const jsonPath = getProfileJsonPath(name);
  const oauthPath = getProfileOAuthPath(name);
  const envPath = getProfileEnvPath(name);

  if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
  if (fs.existsSync(oauthPath)) fs.unlinkSync(oauthPath);
  if (fs.existsSync(envPath)) fs.unlinkSync(envPath);

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
  .description("Add a new profile")
  .option("--oauth", "Use OAuth browser login (recommended)")
  .option("--token", "Use API token (manual entry)")
  .action((name, options) => cmdAdd(name, options));

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
  .description("Output path to current profile env file (API token profiles only)")
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
  .command("login <name>")
  .description("Re-authenticate an OAuth profile")
  .action((name) => cmdLogin(name));

program
  .command("remove <name>")
  .description("Remove a profile")
  .action((name) => cmdRemove(name));

program.parse();
