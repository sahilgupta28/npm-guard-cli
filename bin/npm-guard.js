#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const cfg = require("../lib/config");
const shell = require("../lib/shell");
const { getPackageReport } = require("../lib/checks");

const NPM_COMMANDS_TO_GUARD = new Set(["install", "i", "add", "ci", "update", "up"]);

// ---------------------------------------------------------------------------
// Dependency collection (for bare `npm install` / `npm ci` / `npm update`)
// ---------------------------------------------------------------------------

function collectDepsFromPackageJson(cwd) {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return [];
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const names = new Set();
  for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
    if (pkg[group]) Object.keys(pkg[group]).forEach((n) => names.add(n));
  }
  return [...names];
}

function collectDepsFromLockfile(cwd) {
  const lockPath = path.join(cwd, "package-lock.json");
  if (!fs.existsSync(lockPath)) return [];
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const names = new Set();
  if (lock.packages) {
    for (const key of Object.keys(lock.packages)) {
      if (!key) continue;
      const parts = key.split("node_modules/");
      const name = parts[parts.length - 1];
      if (name) names.add(name);
    }
  } else if (lock.dependencies) {
    Object.keys(lock.dependencies).forEach((n) => names.add(n));
  }
  return [...names];
}

function parsePackageList(args) {
  return args
    .flatMap((a) => a.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripVersion(pkgArg) {
  if (pkgArg.startsWith("@")) {
    const idx = pkgArg.indexOf("@", 1);
    return idx === -1 ? pkgArg : pkgArg.slice(0, idx);
  }
  const idx = pkgArg.indexOf("@");
  return idx === -1 ? pkgArg : pkgArg.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const COLOR_ENABLED = !process.env.NO_COLOR && process.stdout.isTTY;
const ANSI = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m" };

function colorize(text, color) {
  return COLOR_ENABLED ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

function printReport(report, config) {
  const bypassed = config.allowlist.includes(report.name);
  if (report.ok || bypassed) {
    const tag = bypassed && !report.ok ? "BYPASSED" : "OK";
    console.log(`  [${colorize(tag, bypassed && !report.ok ? "yellow" : "green")}] ${report.name}`);
    if (bypassed && !report.ok) {
      report.reasons.forEach((r) => console.log(`         (would have failed: ${r})`));
    }
  } else {
    console.log(`  [${colorize("BLOCKED", "red")}] ${report.name}`);
    report.reasons.forEach((r) => console.log(`         - ${r}`));
  }
  report.warnings.forEach((w) => console.log(`         ${colorize("!", "yellow")} warning: ${w}`));
}

async function checkPackages(names, config) {
  console.log(`\n[npm-guard] Checking reputation for ${names.length} package(s)...\n`);
  const results = [];
  for (const name of names) {
    const report = await getPackageReport(name, config);
    printReport(report, config);
    results.push(report);
  }
  const blocked = results.filter((r) => !r.ok && !config.allowlist.includes(r.name));
  console.log("");
  if (blocked.length > 0) {
    printBlockedSummary(blocked);
  } else {
    console.log("[npm-guard] All packages passed.\n");
  }
  return { results, blocked };
}

function printBlockedSummary(blocked) {
  const names = blocked.map((r) => r.name);
  const list = names.join(",");

  console.log(colorize(`[npm-guard] Blocked ${blocked.length} package(s) for failing the reputation check:`, "red"));
  console.log("");
  names.forEach((n) => console.log(`    - ${n}`));
  console.log("");
  console.log("[npm-guard] What to do next:");
  console.log("");
  console.log("  1) If these are safe, allow them permanently (saved for future installs) — copy/paste:");
  console.log("");
  console.log(colorize(`     npm-guard config allow ${list}`, "green"));
  console.log("");
  console.log("  2) Or allow them for this install only, without saving anything — copy/paste:");
  console.log("");
  console.log(colorize(`     npm install --guard-allow=${list}`, "green"));
  console.log("");
  console.log("  Then re-run your original npm command.\n");
}

// ---------------------------------------------------------------------------
// npm passthrough
// ---------------------------------------------------------------------------

function findRealNpm() {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(finder, ["npm"], { encoding: "utf8" });
  if (result.status === 0) {
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (lines[0]) return lines[0];
  }
  return "npm";
}

function runRealNpm(args) {
  const result = spawnSync(findRealNpm(), args, { stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}

function parseCliArgs(argv) {
  const flags = { allow: [] };
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith("--guard-allow=")) {
      flags.allow.push(...arg.slice("--guard-allow=".length).split(",").map((s) => s.trim()));
    } else if (arg !== "--guard-disable") {
      // --guard-disable is read via env-style check below; keep it out of npm's arg list either way
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function handleNpmPassthrough(argv) {
  const cwd = process.cwd();
  const { flags, positional } = parseCliArgs(argv);
  const guardDisabledThisRun = argv.includes("--guard-disable");

  const npmCommand = positional[0];
  const rest = positional.slice(1);

  if (!npmCommand || !NPM_COMMANDS_TO_GUARD.has(npmCommand)) {
    return runRealNpm(positional); // npm run, npm test, etc. — untouched
  }

  if (!cfg.isEnabled() || guardDisabledThisRun) {
    return runRealNpm(positional); // guard toggled off — pure passthrough
  }

  const config = cfg.loadEffectiveConfig(cwd, flags.allow);
  const explicitPackages = rest.filter((a) => !a.startsWith("-"));
  const flagArgs = rest.filter((a) => a.startsWith("-"));

  let targetPackages = explicitPackages;
  let scanningWholeProject = false;

  if (explicitPackages.length === 0) {
    scanningWholeProject = true;
    targetPackages =
      npmCommand === "ci"
        ? collectDepsFromLockfile(cwd)
        : [...new Set([...collectDepsFromPackageJson(cwd), ...collectDepsFromLockfile(cwd)])];
  }

  if (targetPackages.length === 0) return runRealNpm(positional);

  const { blocked } = await checkPackages(targetPackages, config);

  if (scanningWholeProject) {
    if (blocked.length > 0) {
      console.error(`[npm-guard] Install blocked. Resolve or bypass the package(s) above, then retry.`);
      process.exit(1);
    }
    return runRealNpm(positional);
  }

  const allowedPackages = explicitPackages.filter((p) => !blocked.some((r) => r.name === stripVersion(p)));
  if (allowedPackages.length === 0) {
    console.error("[npm-guard] All requested packages were blocked. Nothing to install.");
    process.exit(1);
  }
  if (allowedPackages.length < explicitPackages.length) {
    const skipped = explicitPackages.filter((p) => !allowedPackages.includes(p));
    console.log(`[npm-guard] Proceeding with: ${allowedPackages.join(", ")} (skipped: ${skipped.join(", ")})`);
  }
  return runRealNpm([npmCommand, ...allowedPackages, ...flagArgs]);
}

// ---------------------------------------------------------------------------
// Management subcommands
// ---------------------------------------------------------------------------

function cmdEnable() {
  cfg.setEnabled(true);
  const touched = shell.addAliasToRcFiles();
  console.log("[npm-guard] Enabled.");
  if (touched.length) {
    console.log(`[npm-guard] Added 'npm' alias to: ${touched.join(", ")}`);
    console.log("[npm-guard] Restart your shell or run: source ~/.bashrc (or ~/.zshrc)");
  } else if (shell.aliasIsInstalled()) {
    console.log("[npm-guard] Alias already present in your shell config.");
  } else {
    console.log("[npm-guard] No shell rc file found to edit automatically.");
    console.log('[npm-guard] Add this line yourself: alias npm="npm-guard"');
  }
}

function cmdDisable() {
  cfg.setEnabled(false);
  console.log("[npm-guard] Disabled. The npm alias (if installed) will now pass straight through.");
}

function cmdUninstall() {
  const touched = shell.removeAliasFromRcFiles();
  cfg.setEnabled(false);
  console.log(touched.length ? `[npm-guard] Removed alias from: ${touched.join(", ")}` : "[npm-guard] No alias found in shell config.");
  console.log("[npm-guard] Restart your shell for npm to resolve normally again.");
}

function cmdStatus() {
  const config = cfg.getGlobalConfig();
  console.log(`Enabled:        ${cfg.isEnabled()}`);
  console.log(`Alias present:  ${shell.aliasIsInstalled()}`);
  console.log(`Global config:  ${cfg.GLOBAL_CONFIG_PATH}`);
  console.log(`  minMonthlyDownloads:        ${config.minMonthlyDownloads}`);
  console.log(`  maxMonthsSinceLastPublish:  ${config.maxMonthsSinceLastPublish}`);
  console.log(`  requireRepository:          ${config.requireRepository}`);
  console.log(`  blockDeprecated:            ${config.blockDeprecated}`);
  console.log(`  allowlist:                  ${config.allowlist.join(", ") || "(none)"}`);
}

function cmdConfig(args) {
  const [action, ...rest] = args;
  if (action === "get") {
    const config = cfg.getGlobalConfig();
    console.log(JSON.stringify(rest[0] ? { [rest[0]]: config[rest[0]] } : config, null, 2));
  } else if (action === "set") {
    const [key, rawValue] = rest;
    if (!key || rawValue === undefined) {
      console.error("Usage: npm-guard config set <key> <value>");
      process.exit(1);
    }
    let value = rawValue;
    if (["true", "false"].includes(rawValue)) value = rawValue === "true";
    else if (!Number.isNaN(Number(rawValue))) value = Number(rawValue);
    cfg.setGlobalConfigValue(key, value);
    console.log(`[npm-guard] Set ${key} = ${value}`);
  } else if (action === "allow") {
    const names = parsePackageList(rest);
    if (names.length === 0) {
      console.error("Usage: npm-guard config allow <pkg>[,<pkg2>,...]");
      process.exit(1);
    }
    cfg.addToGlobalAllowlist(names);
    console.log(`[npm-guard] Added to the global allowlist: ${names.join(", ")}`);
  } else if (action === "disallow") {
    const names = parsePackageList(rest);
    if (names.length === 0) {
      console.error("Usage: npm-guard config disallow <pkg>[,<pkg2>,...]");
      process.exit(1);
    }
    cfg.removeFromGlobalAllowlist(names);
    console.log(`[npm-guard] Removed from the global allowlist: ${names.join(", ")}`);
  } else {
    console.error("Usage: npm-guard config <get|set|allow|disallow> [args]");
    process.exit(1);
  }
}

async function cmdCheck(cwd) {
  const config = cfg.loadEffectiveConfig(cwd, []);
  const names = [...new Set([...collectDepsFromPackageJson(cwd), ...collectDepsFromLockfile(cwd)])];
  if (names.length === 0) {
    console.log("[npm-guard] No dependencies found in package.json or package-lock.json.");
    process.exit(0);
  }
  const { blocked } = await checkPackages(names, config);
  process.exit(blocked.length > 0 ? 1 : 0);
}

function cmdPostinstallMessage() {
  console.log("\nnpm-guard installed.");
  console.log("Run 'npm-guard enable' to start guarding npm i / install / ci / update.");
  console.log("Run 'npm-guard status' any time to see current settings.\n");
}

// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case "enable":
      return cmdEnable();
    case "disable":
      return cmdDisable();
    case "uninstall":
      return cmdUninstall();
    case "status":
      return cmdStatus();
    case "config":
      return cmdConfig(rest);
    case "check":
      return cmdCheck(process.cwd());
    case "postinstall-message":
      return cmdPostinstallMessage();
    default:
      // Anything else is treated as a real npm invocation being passed through the alias,
      // e.g. `npm install express` becomes `npm-guard install express`.
      return handleNpmPassthrough(argv);
  }
}

main().catch((e) => {
  console.error(`[npm-guard] Unexpected error: ${e.message}`);
  process.exit(1);
});
