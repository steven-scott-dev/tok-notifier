const crypto = require("crypto");
const fs = require("fs");

const HASH_FILE = "./last_hash.txt";

const CONFIG = {
  tokportalUrl: process.env.TOKPORTAL_URL,
  tokportalCookie: process.env.TOKPORTAL_COOKIE,
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
  referer:
    process.env.TOKPORTAL_REFERER ||
    "https://app.tokportal.com/account-manager/dashboard",
};

const TEST_MODE = false;
const CHECK_INTERVAL_MS = 15000;

function required(name, value) {
  if (!value) {
    console.error(`❌ Missing required env var: ${name}`);
    process.exit(1);
  }
}

required("TOKPORTAL_URL", CONFIG.tokportalUrl);
required("TOKPORTAL_COOKIE", CONFIG.tokportalCookie);
required("DISCORD_WEBHOOK_URL", CONFIG.discordWebhookUrl);

function readLastHash() {
  try {
    return fs.readFileSync(HASH_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function saveLastHash(hash) {
  fs.writeFileSync(HASH_FILE, hash, "utf8");
}

function buildHeaders() {
  return {
    Accept: "application/json",
    Cookie: CONFIG.tokportalCookie,
    Referer: CONFIG.referer,
    "User-Agent": "TokPortal-Notifier",
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function hashBundles(bundles) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(bundles))
    .digest("hex");
}

async function fetchAvailableBundles() {
  const res = await fetch(CONFIG.tokportalUrl, {
    method: "GET",
    headers: buildHeaders(),
  });

  const rawText = await res.text();

  let json;
  try {
    json = JSON.parse(rawText);
  } catch {
    console.error("❌ Expected JSON from TokPortal but got something else.");
    console.error(rawText.slice(0, 500));
    throw new Error("TokPortal returned non-JSON response");
  }

  if (!res.ok) {
    console.error(`❌ TokPortal request failed: HTTP ${res.status}`);
    console.error(JSON.stringify(json).slice(0, 500));
    throw new Error(`TokPortal HTTP ${res.status}`);
  }

  if (!json || !Array.isArray(json.allBundles)) {
    console.error("❌ Unexpected response from TokPortal");
    console.error(JSON.stringify(json).slice(0, 500));
    throw new Error("TokPortal response missing allBundles array");
  }

  return {
    status: res.status,
    countPublished:
      typeof json.countPublished === "number" ? json.countPublished : null,
    allBundles: json.allBundles,
  };
}

function summarizeBundle(bundle, index) {
  return {
    id: bundle?.id || bundle?._id || `bundle_${index + 1}`,
    type: bundle?.bundle_type || bundle?.type || "Unknown",
    price: bundle?.cm_account_price ?? null,
  };
}

async function sendDiscordAlert({ countPublished, bundles }) {
  if (!bundles.length) return;

  const preview = bundles.slice(0, 10).map((b, i) => {
    return `#${i + 1} | ${b.type} | ${b.price ?? "n/a"} | ${b.id}`;
  });

  const payload = {
    username: "TokPortal Notifier",
    content: "@everyone 🚨 TOKPORTAL JOB ALERT 🚨",
    embeds: [
      {
        title: "🚨 TokPortal Bundles Available",
        color: 16753920,
        description: preview.join("\n") || "Bundles detected but details unavailable.",
        fields: [
          {
            name: "Bundle Count",
            value: String(bundles.length),
            inline: true,
          },
          {
            name: "Published",
            value: String(countPublished ?? "unknown"),
            inline: true,
          },
          {
            name: "Checked At",
            value: new Date().toISOString(),
            inline: false,
          },
        ],
      },
    ],
  };

  const res = await fetch(CONFIG.discordWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`❌ Discord webhook failed: HTTP ${res.status}`);
    console.error(text.slice(0, 500));
    throw new Error(`Discord webhook HTTP ${res.status}`);
  }

  console.log("✅ Discord alert sent");
}

async function main() {
  console.log("🚀 TokPortal notifier check starting...");
  console.log("BUILD: CLAY-FIXED-CLEAN");
  console.log("TEST_MODE:", TEST_MODE);

  const result = await fetchAvailableBundles();
  const bundles = result.allBundles;
  const summarizedBundles = bundles.map(summarizeBundle);
  const bundleHash = hashBundles(bundles);
  const lastHash = readLastHash();

  console.log(`HTTP status: ${result.status}`);
  console.log(`countPublished: ${result.countPublished}`);
  console.log(`allBundles.length: ${bundles.length}`);
  console.log(`lastHash: ${lastHash || "(empty)"}`);
  console.log(`bundleHash: ${bundleHash}`);

  if (TEST_MODE) {
    console.log("🧪 TEST MODE — forcing alert");
    await sendDiscordAlert({
      countPublished: result.countPublished,
      bundles: summarizedBundles,
    });
    return;
  }

  if (bundles.length === 0) {
    console.log("0 bundles — exiting without alert");
    return;
  }

  if (bundleHash === lastHash) {
    console.log("Bundles unchanged — exiting");
    return;
  }

  console.log("✅ New bundles detected");

  await sendDiscordAlert({
    countPublished: result.countPublished,
    bundles: summarizedBundles,
  });

  saveLastHash(bundleHash);
  console.log("✅ Saved new bundle hash");
}

async function loop() {
  try {
    await main();
  } catch (e) {
    console.error("Fatal:", e.message);
  }

  setTimeout(loop, CHECK_INTERVAL_MS);
}

console.log("BUILD: CLAY-FIXED-LOOP");
loop();
