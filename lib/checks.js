const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS_API = "https://api.npmjs.org/downloads/point/last-month";
const OSV_API = "https://api.osv.dev/v1/query";
const INSTALL_SCRIPT_NAMES = ["preinstall", "install", "postinstall"];
const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Both api.npmjs.org and api.osv.dev rate-limit per IP; a big dependency tree
// checked back-to-back trips them even with retries, since every request gets
// throttled, not just the unlucky ones. Serialize each endpoint's calls with a
// floor on their spacing so we never burst past the limit in the first place.
function makeThrottle(minIntervalMs) {
  let queue = Promise.resolve(0);
  return function throttle(run) {
    const scheduled = queue.then(async (lastCallAt) => {
      const wait = lastCallAt + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      return Date.now();
    });
    queue = scheduled.catch(() => Date.now());
    return scheduled.then(run);
  };
}

const throttleDownloadsCall = makeThrottle(300);
const throttleOsvCall = makeThrottle(300);

async function fetchJson(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 404) return null;

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfterHeader = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
      await sleep(delay);
      continue;
    }

    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
}

async function fetchKnownMalwareIds(name) {
  const res = await fetch(OSV_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package: { name, ecosystem: "npm" } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${OSV_API}`);
  const data = await res.json();
  const vulns = data.vulns || [];
  // OSV ids prefixed "MAL-" come from the OSSF malicious-packages feed —
  // packages actually pulled from npm for malicious code, not just CVEs.
  return vulns.filter((v) => v.id.startsWith("MAL-")).map((v) => v.id);
}

async function getPackageReport(name, config) {
  const report = { name, ok: true, reasons: [], warnings: [], stats: {} };

  let packument;
  try {
    packument = await fetchJson(`${REGISTRY}/${encodeURIComponent(name)}`);
  } catch (e) {
    report.ok = false;
    report.reasons.push(`Could not reach npm registry (${e.message})`);
    return report;
  }

  if (!packument) {
    report.ok = false;
    report.reasons.push("Package not found in npm registry");
    return report;
  }

  const latestVersion = packument["dist-tags"] && packument["dist-tags"].latest;
  const latestMeta = latestVersion && packument.versions ? packument.versions[latestVersion] : null;

  let monthsSincePublish = null;
  if (packument.time && latestVersion && packument.time[latestVersion]) {
    const publishedAt = new Date(packument.time[latestVersion]);
    monthsSincePublish = (Date.now() - publishedAt.getTime()) / (1000 * 60 * 60 * 24 * 30);
    report.stats.lastPublished = publishedAt.toISOString().slice(0, 10);
    report.stats.monthsSincePublish = Math.round(monthsSincePublish * 10) / 10;
  }

  let downloads = null;
  try {
    const downloadData = await throttleDownloadsCall(() =>
      fetchJson(`${DOWNLOADS_API}/${encodeURIComponent(name)}`)
    );
    downloads = downloadData ? downloadData.downloads : 0;
    report.stats.monthlyDownloads = downloads;
  } catch (e) {
    report.warnings.push(`Could not fetch download stats (${e.message})`);
  }

  let malwareIds = [];
  try {
    malwareIds = await throttleOsvCall(() => fetchKnownMalwareIds(name));
  } catch (e) {
    report.warnings.push(`Could not check malware database (${e.message})`);
  }

  const isDeprecated = !!(latestMeta && latestMeta.deprecated);
  report.stats.deprecated = isDeprecated;

  const hasRepository = !!(packument.repository || (latestMeta && latestMeta.repository));
  report.stats.hasRepository = hasRepository;

  const installScripts = INSTALL_SCRIPT_NAMES.filter((s) => latestMeta && latestMeta.scripts && latestMeta.scripts[s]);
  report.stats.installScripts = installScripts;

  if (malwareIds.length > 0 && config.blockMalware) {
    report.ok = false;
    report.reasons.push(`Flagged as known malware in the OSV database (${malwareIds.join(", ")})`);
  }

  if (isDeprecated && config.blockDeprecated) {
    report.ok = false;
    report.reasons.push("Package is marked deprecated on npm");
  }

  if (downloads !== null && downloads < config.minMonthlyDownloads) {
    report.ok = false;
    report.reasons.push(`Only ${downloads} monthly downloads (minimum: ${config.minMonthlyDownloads})`);
  }

  if (monthsSincePublish !== null && monthsSincePublish > config.maxMonthsSinceLastPublish) {
    report.ok = false;
    report.reasons.push(
      `Last published ${report.stats.monthsSincePublish} months ago (maximum: ${config.maxMonthsSinceLastPublish})`
    );
  }

  if (!hasRepository) {
    const msg = "No repository field listed on npm";
    if (config.requireRepository) {
      report.ok = false;
      report.reasons.push(msg);
    } else {
      report.warnings.push(msg);
    }
  }

  if (installScripts.length > 0) {
    report.warnings.push(`Runs ${installScripts.join(", ")} script(s) on install — review before trusting`);
  }

  return report;
}

module.exports = { getPackageReport };
