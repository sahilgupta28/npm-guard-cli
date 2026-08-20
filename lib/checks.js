const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS_API = "https://api.npmjs.org/downloads/point/last-month";

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.json();
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
    const downloadData = await fetchJson(`${DOWNLOADS_API}/${encodeURIComponent(name)}`);
    downloads = downloadData ? downloadData.downloads : 0;
    report.stats.monthlyDownloads = downloads;
  } catch (e) {
    report.warnings.push(`Could not fetch download stats (${e.message})`);
  }

  const isDeprecated = !!(latestMeta && latestMeta.deprecated);
  report.stats.deprecated = isDeprecated;

  const hasRepository = !!(packument.repository || (latestMeta && latestMeta.repository));
  report.stats.hasRepository = hasRepository;

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

  return report;
}

module.exports = { getPackageReport };
