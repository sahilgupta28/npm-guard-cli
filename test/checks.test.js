const test = require("node:test");
const assert = require("node:assert/strict");
const { getPackageReport } = require("../lib/checks");

const BASE_CONFIG = {
  minMonthlyDownloads: 0,
  maxMonthsSinceLastPublish: 999,
  requireRepository: false,
  blockDeprecated: true,
  blockMalware: true,
  allowlist: [],
};

function packument(name) {
  return {
    "dist-tags": { latest: "1.0.0" },
    time: { "1.0.0": new Date().toISOString() },
    versions: { "1.0.0": { repository: { type: "git", url: `git+https://example.com/${name}.git` } } },
  };
}

function mockFetch({ osvIds = [] } = {}) {
  return async (url, opts) => {
    const href = String(url);
    if (href.includes("api.osv.dev")) {
      const body = { vulns: osvIds.map((id) => ({ id })) };
      return { ok: true, status: 200, json: async () => body };
    }
    if (href.includes("api.npmjs.org/downloads")) {
      return { ok: true, status: 200, json: async () => ({ downloads: 5000 }) };
    }
    if (href.includes("registry.npmjs.org")) {
      return { ok: true, status: 200, json: async () => packument(href) };
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };
}

test("flags a package the OSV malicious-packages feed knows about", async () => {
  const originalFetch = global.fetch;
  global.fetch = mockFetch({ osvIds: ["MAL-2024-1234"] });
  try {
    const report = await getPackageReport("some-typosquat", BASE_CONFIG);
    assert.equal(report.ok, false);
    assert.ok(report.reasons.some((r) => r.includes("MAL-2024-1234")));
  } finally {
    global.fetch = originalFetch;
  }
});

test("does not flag a package with no OSV malware entries", async () => {
  const originalFetch = global.fetch;
  global.fetch = mockFetch({ osvIds: [] });
  try {
    const report = await getPackageReport("some-clean-package", BASE_CONFIG);
    assert.equal(report.ok, true);
  } finally {
    global.fetch = originalFetch;
  }
});
