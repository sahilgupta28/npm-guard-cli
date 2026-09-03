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

// Both the registry lookup and the post-check filter need to key off the
// same (version-stripped) name — otherwise a report for "pkg" never matches
// a blocked-check against "pkg@1.2.3" and a blocked package slips through.
function filterAllowedPackages(explicitPackages, blocked) {
  const blockedNames = new Set(blocked.map((r) => r.name));
  return explicitPackages.filter((p) => !blockedNames.has(stripVersion(p)));
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
  const ignored = names.filter((n) => config.ignore.includes(n));
  const toCheck = names.filter((n) => !config.ignore.includes(n));

  if (ignored.length > 0) {
    console.log(`\n[npm-guard] Skipping ${ignored.length} ignored package(s): ${ignored.join(", ")}`);
  }
  if (toCheck.length === 0) {
    console.log("");
    return { results: [], blocked: [] };
  }

  console.log(`\n[npm-guard] Checking reputation for ${toCheck.length} package(s)...\n`);
  const results = [];
  for (const name of toCheck) {
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
    // Guard against ever resolving back to this very script (e.g. if a future
    // install method puts npm-guard on PATH as a file literally named "npm",
    // rather than only via a shell alias) — that would recurse forever.
    const candidate = lines.find((line) => {
      try {
        return fs.realpathSync(line) !== fs.realpathSync(__filename);
      } catch (e) {
        return true;
      }
    });
    if (candidate) return candidate;
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

  let targetPackages = explicitPackages.map(stripVersion);
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

  const allowedPackages = filterAllowedPackages(explicitPackages, blocked);
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
  const cwd = process.cwd();
  const projectConfig = cfg.getProjectConfig(cwd);
  const hasProjectConfig = Object.keys(projectConfig).length > 0;
  const effective = cfg.loadEffectiveConfig(cwd, []);

  console.log(`Enabled:        ${cfg.isEnabled()}`);
  console.log(`Strict mode:    ${cfg.isStrictMode()} (set NPM_GUARD_STRICT=1 to stop projects from relaxing rules)`);
  console.log(`Alias present:  ${shell.aliasIsInstalled()}`);
  console.log(`Global config:  ${cfg.GLOBAL_CONFIG_PATH}`);
  console.log(
    `Project config: ${hasProjectConfig ? cfg.getProjectConfigPath(cwd) : `(none found in ${cwd})`}`
  );
  console.log("");
  console.log("Effective settings (project overrides global; allowlists are combined):");
  console.log(`  minMonthlyDownloads:        ${effective.minMonthlyDownloads}`);
  console.log(`  maxMonthsSinceLastPublish:  ${effective.maxMonthsSinceLastPublish}`);
  console.log(`  requireRepository:          ${effective.requireRepository}`);
  console.log(`  blockDeprecated:            ${effective.blockDeprecated}`);
  console.log(`  blockMalware:               ${effective.blockMalware}`);
  console.log(`  allowlist:                  ${effective.allowlist.join(", ") || "(none)"}`);
  console.log(`  ignore (never checked):     ${effective.ignore.join(", ") || "(none)"}`);
}

// allowlist: still checked and reported, just never blocks.
// ignore:    never looked up at all — no network call, no per-package output.
const LIST_ACTIONS = {
  allow: { listKey: "allowlist", label: "allowlist", add: true },
  disallow: { listKey: "allowlist", label: "allowlist", add: false },
  ignore: { listKey: "ignore", label: "ignore list", add: true },
  unignore: { listKey: "ignore", label: "ignore list", add: false },
};

function cmdConfig(args) {
  const isProject = args.includes("--project");
  const [action, ...rest] = isProject ? args.filter((a) => a !== "--project") : args;
  const cwd = process.cwd();
  const scope = isProject ? "project" : "global";

  if (action === "get") {
    const config = isProject ? cfg.getProjectConfig(cwd) : cfg.getGlobalConfig();
    console.log(JSON.stringify(rest[0] ? { [rest[0]]: config[rest[0]] } : config, null, 2));
  } else if (action === "set") {
    const [key, rawValue] = rest;
    if (!key || rawValue === undefined) {
      console.error("Usage: npm-guard config set <key> <value> [--project]");
      process.exit(1);
    }
    let value = rawValue;
    if (["true", "false"].includes(rawValue)) value = rawValue === "true";
    else if (!Number.isNaN(Number(rawValue))) value = Number(rawValue);
    if (isProject) cfg.setProjectConfigValue(cwd, key, value);
    else cfg.setGlobalConfigValue(key, value);
    console.log(`[npm-guard] Set ${key} = ${value} (${scope})`);
  } else if (LIST_ACTIONS[action]) {
    const { listKey, label, add } = LIST_ACTIONS[action];
    const names = parsePackageList(rest);
    if (names.length === 0) {
      console.error(`Usage: npm-guard config ${action} <pkg>[,<pkg2>,...] [--project]`);
      process.exit(1);
    }
    if (isProject) {
      (add ? cfg.addToProjectList : cfg.removeFromProjectList)(cwd, listKey, names);
    } else {
      (add ? cfg.addToGlobalList : cfg.removeFromGlobalList)(listKey, names);
    }
    const verb = add ? "Added to" : "Removed from";
    console.log(`[npm-guard] ${verb} the ${scope} ${label}: ${names.join(", ")}`);
  } else {
    console.error("Usage: npm-guard config <get|set|allow|disallow|ignore|unignore> [args] [--project]");
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

if (require.main === module) {
  main().catch((e) => {
    console.error(`[npm-guard] Unexpected error: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { stripVersion, filterAllowedPackages, parsePackageList, collectDepsFromPackageJson, collectDepsFromLockfile };
