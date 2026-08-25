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
    cfg.addToProjectAllowlist(dir, ["some-project-only-package"]);
    const effective = cfg.loadEffectiveConfig(dir, []);
    assert.ok(effective.allowlist.includes("some-project-only-package"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeFromProjectAllowlist removes an entry from the project file only", () => {
  const dir = makeTmpProject();
  try {
    cfg.addToProjectAllowlist(dir, ["temp-pkg"]);
    cfg.removeFromProjectAllowlist(dir, ["temp-pkg"]);
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
