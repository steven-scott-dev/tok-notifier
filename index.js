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

function required(name, value) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
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
  fs.writeFileSync(HASH_FILE, hash);
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

  const json = await res.json();

  if (!json || !Array.isArray(json.allBundles)) {
    console.error("Unexpected response from TokPortal");
    process.exit(1);
  }

  return {
    countPublished: json.countPublished,
    allBundles: json.allBundles,
  };
}

function summarizeBundle(bundle, index) {
  return {
    id: bundle.id || bundle._id || `bundle_${index}`,
    type: bundle.bundle_type || bundle.type || "Unknown",
    price: bundle.cm_account_price || null,
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
        title: "TokPortal Bundles Available",
        color: 16753920,
        description: preview.join("\n"),
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
        ],
      },
    ],
  };

  await fetch(CONFIG.discordWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function main() {
  const result = await fetchAvailableBundles();

  const bundles = result.allBundles;
  const hash = hashBundles(bundles);
  const lastHash = readLastHash();

  console.log("Bundles:", bundles.length);

  if (TEST_MODE) {
    await sendDiscordAlert({
      countPublished: result.countPublished,
      bundles: bundles.map(summarizeBundle),
    });
    return;
  }

  if (bundles.length === 0) {
    console.log("No bundles available");
    return;
  }

  if (hash === lastHash) {
    console.log("No change");
    return;
  }

  console.log("New bundles detected");

  await sendDiscordAlert({
    countPublished: result.countPublished,
    bundles: bundles.map(summarizeBundle),
  });

  saveLastHash(hash);
}

setInterval(async () => {
  try {
    await main();
  } catch (e) {
    console.error("Fatal:", e.message);
  }
}, 15000);

      console.log("BUILD: CLAY-INTERVAL-DEPLOY");
