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
  // Never looked up at all — unlike allowlist, which still checks and reports.
  ignore: [],
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
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function writeGlobalJson(filePath, data) {
  ensureGuardDir();
  writeJson(filePath, data);
}

// ---- Global config (persists across all projects) ----

function getGlobalConfig() {
  return { ...DEFAULT_CONFIG, ...(readJsonSafe(GLOBAL_CONFIG_PATH) || {}) };
}

function setGlobalConfigValue(key, value) {
  const config = getGlobalConfig();
  config[key] = value;
  writeGlobalJson(GLOBAL_CONFIG_PATH, config);
  return config;
}

// listKey is "allowlist" or "ignore" — both are plain arrays of package names
// merged the same way, so they share one set of read/modify/write helpers.
function addToGlobalList(listKey, pkgNames) {
  const names = Array.isArray(pkgNames) ? pkgNames : [pkgNames];
  const config = getGlobalConfig();
  if (!Array.isArray(config[listKey])) config[listKey] = [];
  for (const name of names) {
    if (name && !config[listKey].includes(name)) config[listKey].push(name);
  }
  writeGlobalJson(GLOBAL_CONFIG_PATH, config);
  return config;
}

function removeFromGlobalList(listKey, pkgNames) {
  const names = Array.isArray(pkgNames) ? pkgNames : [pkgNames];
  const config = getGlobalConfig();
  config[listKey] = (config[listKey] || []).filter((p) => !names.includes(p));
  writeGlobalJson(GLOBAL_CONFIG_PATH, config);
  return config;
}

// ---- Project config (this repo only; wins over global for scalar settings) ----

function getProjectConfigPath(cwd) {
  return path.join(cwd, "npm-guard.config.json");
}

function getProjectConfig(cwd) {
  return readJsonSafe(getProjectConfigPath(cwd)) || {};
}

function setProjectConfigValue(cwd, key, value) {
  const config = getProjectConfig(cwd);
  config[key] = value;
  writeJson(getProjectConfigPath(cwd), config);
  return config;
}

function addToProjectList(cwd, listKey, pkgNames) {
  const names = Array.isArray(pkgNames) ? pkgNames : [pkgNames];
  const config = getProjectConfig(cwd);
  if (!Array.isArray(config[listKey])) config[listKey] = [];
  for (const name of names) {
    if (name && !config[listKey].includes(name)) config[listKey].push(name);
  }
  writeJson(getProjectConfigPath(cwd), config);
  return config;
}

function removeFromProjectList(cwd, listKey, pkgNames) {
  const names = Array.isArray(pkgNames) ? pkgNames : [pkgNames];
  const config = getProjectConfig(cwd);
  config[listKey] = (config[listKey] || []).filter((p) => !names.includes(p));
  writeJson(getProjectConfigPath(cwd), config);
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

// ---- Strict mode: the project you're about to `npm install` into can ship its own
// npm-guard.config.json / npmGuard field. Normally that's convenient (a repo can pre-approve
// its own deps), but it also means an untrusted project can silently turn its own guard off
// (blockMalware: false, minMonthlyDownloads: 0, ...) with no prompt. In strict mode, project
// and package.json config may still ADD to the allowlist, but may never relax a scalar rule
// below the global setting.

function isStrictMode() {
  return ["1", "true", "yes"].includes((process.env.NPM_GUARD_STRICT || "").toLowerCase());
}

// For each scalar rule, whether moving from `current` to `next` makes the check *less* strict.
const RELAXES_RULE = {
  minMonthlyDownloads: (current, next) => next < current,
  maxMonthsSinceLastPublish: (current, next) => next > current,
  requireRepository: (current, next) => current === true && next === false,
  blockDeprecated: (current, next) => current === true && next === false,
  blockMalware: (current, next) => current === true && next === false,
};

// Array settings are unioned by mergeLists below, not overwritten here — a scalar
// merge of "ignore" would also bypass the strict-mode gate on it.
const LIST_KEYS = ["allowlist", "ignore"];

function mergeScalarOverrides(config, overrides, strict) {
  const next = { ...config };
  for (const key of Object.keys(overrides)) {
    if (LIST_KEYS.includes(key)) continue;
    const isRelaxation = RELAXES_RULE[key] && RELAXES_RULE[key](config[key], overrides[key]);
    if (strict && isRelaxation) continue; // ignore a project trying to loosen a rule
    next[key] = overrides[key];
  }
  return next;
}

// ---- Merged config: global <- project file <- package.json field <- env <- CLI flag ----
// Scalar settings (minMonthlyDownloads, blockDeprecated, ...) follow that order, so a
// project-level value always wins over global. Allowlists are combined (union) from every
// level instead, since an "ignore this package" entry from any source should still apply.

function loadEffectiveConfig(cwd, cliAllow) {
  let config = getGlobalConfig();
  const strict = isStrictMode();

  // An ignore entry skips the lookup entirely, so a project-level one can hide a
  // malware hit that an allowlist entry would still have printed as BYPASSED.
  // Strict mode therefore drops project ignores; only your global list applies.
  const mergeLists = (overrides) => {
    if (Array.isArray(overrides.allowlist)) {
      config.allowlist = [...config.allowlist, ...overrides.allowlist];
    }
    if (!strict && Array.isArray(overrides.ignore)) {
      config.ignore = [...config.ignore, ...overrides.ignore];
    }
  };

  const projectConfig = getProjectConfig(cwd);
  if (projectConfig) {
    config = mergeScalarOverrides(config, projectConfig, strict);
    mergeLists(projectConfig);
  }

  const pkgJson = readJsonSafe(path.join(cwd, "package.json"));
  if (pkgJson && pkgJson.npmGuard) {
    config = mergeScalarOverrides(config, pkgJson.npmGuard, strict);
    mergeLists(pkgJson.npmGuard);
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
  config.ignore = [...new Set(config.ignore || [])];
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
  addToGlobalList,
  removeFromGlobalList,
  getState,
  setEnabled,
  isEnabled,
  isStrictMode,
  loadEffectiveConfig,
  getProjectConfigPath,
  getProjectConfig,
  setProjectConfigValue,
  addToProjectList,
  removeFromProjectList,
};
