const test = require("node:test");
const assert = require("node:assert/strict");
const { stripVersion, filterAllowedPackages, parsePackageList } = require("../bin/npm-guard.js");

test("stripVersion removes a plain version specifier", () => {
  assert.equal(stripVersion("left-pad@1.3.0"), "left-pad");
  assert.equal(stripVersion("left-pad"), "left-pad");
});

test("stripVersion handles scoped packages", () => {
  assert.equal(stripVersion("@scope/pkg@1.2.3"), "@scope/pkg");
  assert.equal(stripVersion("@scope/pkg"), "@scope/pkg");
});

test("a blocked package installed with a version specifier is filtered out", () => {
  // Regression test for the bug where `npm install evil-pkg@1.0.0` printed
  // [BLOCKED] but installed the package anyway, because the blocked report's
  // name and the filter's comparison name were stripped inconsistently.
  const explicitPackages = ["evil-pkg@1.0.0", "left-pad"];
  const blocked = [{ name: "evil-pkg" }]; // reports are keyed by the stripped name
  const allowed = filterAllowedPackages(explicitPackages, blocked);
  assert.deepEqual(allowed, ["left-pad"]);
});

test("an unversioned blocked package is still filtered out", () => {
  const explicitPackages = ["evil-pkg", "left-pad"];
  const blocked = [{ name: "evil-pkg" }];
  const allowed = filterAllowedPackages(explicitPackages, blocked);
  assert.deepEqual(allowed, ["left-pad"]);
});

test("nothing is filtered when nothing is blocked", () => {
  const explicitPackages = ["left-pad@1.3.0", "express"];
  const allowed = filterAllowedPackages(explicitPackages, []);
  assert.deepEqual(allowed, explicitPackages);
});

test("parsePackageList splits comma-separated and space-separated args", () => {
  assert.deepEqual(parsePackageList(["a,b", " c "]), ["a", "b", "c"]);
});
