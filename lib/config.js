const fs = require("fs");
const path = require("path");
const os = require("os");

const GUARD_DIR = path.join(os.homedir(), ".npm-guard");
const GLOBAL_CONFIG_PATH = path.join(GUARD_DIR, "config.json");
const STATE_PATH = path.join(GUARD_DIR, "state.json");
const OWN_PACKAGE_NAME = require("../package.json").name;

const DEFAULT_CONFIG = {
  minMonthlyDownloads: 1000,
  maxMonthsSinceLastPublish: 24,
  requireRepository: false,
  blockDeprecated: true,
  blockMalware: true,
  allowlist: [],
};

function ensureGuardDir() {
  if (!fs.existsSync(GUARD_DIR)) fs.mkdirSync(GUARD_DIR, { recursive: true });
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.warn(`[npm-guard] Warning: could not parse ${filePath} (${e.message})`);
    return null;
  }
}

function writeJson(filePath, data) {
  ensureGuardDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

// ---- Global config (persists across all projects) ----

function getGlobalConfig() {
  return { ...DEFAULT_CONFIG, ...(readJsonSafe(GLOBAL_CONFIG_PATH) || {}) };
}

function setGlobalConfigValue(key, value) {
  const config = getGlobalConfig();
  config[key] = value;
  writeJson(GLOBAL_CONFIG_PATH, config);
  return config;
}

function addToGlobalAllowlist(pkgNames) {
  const names = Array.isArray(pkgNames) ? pkgNames : [pkgNames];
  const config = getGlobalConfig();
  for (const name of names) {
    if (name && !config.allowlist.includes(name)) config.allowlist.push(name);
  }
  writeJson(GLOBAL_CONFIG_PATH, config);
  return config;
}

function removeFromGlobalAllowlist(pkgNames) {
  const names = Array.isArray(pkgNames) ? pkgNames : [pkgNames];
  const config = getGlobalConfig();
  config.allowlist = config.allowlist.filter((p) => !names.includes(p));
  writeJson(GLOBAL_CONFIG_PATH, config);
  return config;
}

// ---- Enabled/disabled state (fast toggle, no shell edits needed) ----

function getState() {
  return { enabled: false, ...(readJsonSafe(STATE_PATH) || {}) };
}

function setEnabled(enabled) {
  const state = getState();
  state.enabled = enabled;
  writeJson(STATE_PATH, state);
}

function isEnabled() {
  // Env var always wins, for CI/session-level overrides without touching state file.
  if (process.env.NPM_GUARD_ENABLED !== undefined) {
    return ["1", "true", "yes"].includes(process.env.NPM_GUARD_ENABLED.toLowerCase());
  }
  if (process.env.NPM_GUARD_DISABLE === "1") return false;
  return getState().enabled === true;
}

// ---- Merged config: global <- project file <- package.json field <- env <- CLI flag ----

function loadEffectiveConfig(cwd, cliAllow) {
  let config = getGlobalConfig();

  const projectConfigPath = path.join(cwd, "npm-guard.config.json");
  const projectConfig = readJsonSafe(projectConfigPath);
  if (projectConfig) {
    config = { ...config, ...projectConfig };
    if (Array.isArray(projectConfig.allowlist)) {
      config.allowlist = [...config.allowlist, ...projectConfig.allowlist];
    }
  }

  const pkgJson = readJsonSafe(path.join(cwd, "package.json"));
  if (pkgJson && pkgJson.npmGuard) {
    const g = pkgJson.npmGuard;
    config = { ...config, ...g };
    if (Array.isArray(g.allowlist)) {
      config.allowlist = [...config.allowlist, ...g.allowlist];
    }
  }

  if (process.env.NPM_GUARD_ALLOW) {
    config.allowlist.push(
      ...process.env.NPM_GUARD_ALLOW.split(",").map((s) => s.trim()).filter(Boolean)
    );
  }
  if (cliAllow && cliAllow.length) {
    config.allowlist.push(...cliAllow);
  }

  config.allowlist.push(OWN_PACKAGE_NAME);
  config.allowlist = [...new Set(config.allowlist)];
  return config;
}

module.exports = {
  GUARD_DIR,
  GLOBAL_CONFIG_PATH,
  STATE_PATH,
  OWN_PACKAGE_NAME,
  DEFAULT_CONFIG,
  getGlobalConfig,
  setGlobalConfigValue,
  addToGlobalAllowlist,
  removeFromGlobalAllowlist,
  getState,
  setEnabled,
  isEnabled,
  loadEffectiveConfig,
};
