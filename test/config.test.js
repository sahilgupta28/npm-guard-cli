const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cfg = require("../lib/config");

function makeTmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "npm-guard-test-"));
}

test("project config overrides global config for scalar settings", () => {
  const dir = makeTmpProject();
  try {
    cfg.setProjectConfigValue(dir, "minMonthlyDownloads", 424242);
    const effective = cfg.loadEffectiveConfig(dir, []);
    assert.equal(effective.minMonthlyDownloads, 424242);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("project allowlist entries are merged into the effective allowlist", () => {
  const dir = makeTmpProject();
  try {
    cfg.addToProjectList(dir, "allowlist", ["some-project-only-package"]);
    const effective = cfg.loadEffectiveConfig(dir, []);
    assert.ok(effective.allowlist.includes("some-project-only-package"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeFromProjectList removes an entry from the project file only", () => {
  const dir = makeTmpProject();
  try {
    cfg.addToProjectList(dir, "allowlist", ["temp-pkg"]);
    cfg.removeFromProjectList(dir, "allowlist", ["temp-pkg"]);
    const project = cfg.getProjectConfig(dir);
    assert.ok(!(project.allowlist || []).includes("temp-pkg"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a project with no config file falls back to global settings untouched", () => {
  const dir = makeTmpProject();
  try {
    const global = cfg.getGlobalConfig();
    const effective = cfg.loadEffectiveConfig(dir, []);
    assert.equal(effective.maxMonthsSinceLastPublish, global.maxMonthsSinceLastPublish);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without strict mode, a project can relax blockMalware", () => {
  const dir = makeTmpProject();
  try {
    cfg.setProjectConfigValue(dir, "blockMalware", false);
    const effective = cfg.loadEffectiveConfig(dir, []);
    assert.equal(effective.blockMalware, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("strict mode ignores a project trying to relax blockMalware or blockDeprecated", () => {
  const dir = makeTmpProject();
  const originalStrict = process.env.NPM_GUARD_STRICT;
  process.env.NPM_GUARD_STRICT = "1";
  try {
    cfg.setProjectConfigValue(dir, "blockMalware", false);
    cfg.setProjectConfigValue(dir, "blockDeprecated", false);
    const effective = cfg.loadEffectiveConfig(dir, []);
    assert.equal(effective.blockMalware, true);
    assert.equal(effective.blockDeprecated, true);
  } finally {
    if (originalStrict === undefined) delete process.env.NPM_GUARD_STRICT;
    else process.env.NPM_GUARD_STRICT = originalStrict;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("strict mode ignores a project lowering minMonthlyDownloads or raising maxMonthsSinceLastPublish", () => {
  const dir = makeTmpProject();
  const originalStrict = process.env.NPM_GUARD_STRICT;
  process.env.NPM_GUARD_STRICT = "1";
  try {
    const global = cfg.getGlobalConfig();
    cfg.setProjectConfigValue(dir, "minMonthlyDownloads", 0);
    cfg.setProjectConfigValue(dir, "maxMonthsSinceLastPublish", 999999);
    const effective = cfg.loadEffectiveConfig(dir, []);
    assert.equal(effective.minMonthlyDownloads, global.minMonthlyDownloads);
    assert.equal(effective.maxMonthsSinceLastPublish, global.maxMonthsSinceLastPublish);
  } finally {
    if (originalStrict === undefined) delete process.env.NPM_GUARD_STRICT;
    else process.env.NPM_GUARD_STRICT = originalStrict;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("strict mode still allows a project to make rules stricter, and still honors allowlist additions", () => {
  const dir = makeTmpProject();
  const originalStrict = process.env.NPM_GUARD_STRICT;
  process.env.NPM_GUARD_STRICT = "1";
  try {
    cfg.setProjectConfigValue(dir, "minMonthlyDownloads", 999999);
    cfg.addToProjectList(dir, "allowlist", ["some-trusted-package"]);
    const effective = cfg.loadEffectiveConfig(dir, []);
    assert.equal(effective.minMonthlyDownloads, 999999);
    assert.ok(effective.allowlist.includes("some-trusted-package"));
  } finally {
    if (originalStrict === undefined) delete process.env.NPM_GUARD_STRICT;
    else process.env.NPM_GUARD_STRICT = originalStrict;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a project ignore list is merged into the effective config", () => {
  const dir = makeTmpProject();
  try {
    cfg.addToProjectList(dir, "ignore", ["some-internal-package"]);
    const effective = cfg.loadEffectiveConfig(dir, []);
    assert.ok(effective.ignore.includes("some-internal-package"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeFromProjectList drops an ignore entry", () => {
  const dir = makeTmpProject();
  try {
    cfg.addToProjectList(dir, "ignore", ["temp-pkg"]);
    cfg.removeFromProjectList(dir, "ignore", ["temp-pkg"]);
    assert.ok(!(cfg.getProjectConfig(dir).ignore || []).includes("temp-pkg"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("strict mode drops a project-level ignore list, since it would skip the check silently", () => {
  const dir = makeTmpProject();
  const originalStrict = process.env.NPM_GUARD_STRICT;
  process.env.NPM_GUARD_STRICT = "1";
  try {
    cfg.addToProjectList(dir, "ignore", ["untrusted-repo-skips-this"]);
    const effective = cfg.loadEffectiveConfig(dir, []);
    assert.ok(!effective.ignore.includes("untrusted-repo-skips-this"));
  } finally {
    if (originalStrict === undefined) delete process.env.NPM_GUARD_STRICT;
    else process.env.NPM_GUARD_STRICT = originalStrict;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
