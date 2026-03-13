const crypto = require("crypto");

const CONFIG = {
  tokportalUrl: process.env.TOKPORTAL_URL,
  tokportalCookie: process.env.TOKPORTAL_COOKIE,
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
  stateHash: process.env.LAST_BUNDLE_HASH || "",
  referer:
    process.env.TOKPORTAL_REFERER ||
    "https://app.tokportal.com/account-manager/dashboard",
};

const TEST_MODE = false; // turn to false after Discord test works

console.log("TOK NOTIFIER BUILD: CLAY-0312-A");
console.log("TEST_MODE:", TEST_MODE);

function required(name, value) {
  if (!value) {
    console.error(`❌ Missing required env var: ${name}`);
    process.exit(1);
  }
}

required("TOKPORTAL_URL", CONFIG.tokportalUrl);
required("TOKPORTAL_COOKIE", CONFIG.tokportalCookie);
required("DISCORD_WEBHOOK_URL", CONFIG.discordWebhookUrl);

function buildHeaders() {
  return {
    Accept: "application/json",
    "User-Agent": "TokPortal-Notifier/1.0",
    Cookie: CONFIG.tokportalCookie,
    Referer: CONFIG.referer,
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

  let json = null;
  try {
    json = JSON.parse(rawText);
  } catch {
    console.error(`❌ Expected JSON but got non-JSON response. HTTP ${res.status}`);
    console.error(rawText.slice(0, 500));
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`❌ TokPortal request failed: HTTP ${res.status}`);
    console.error(JSON.stringify(json).slice(0, 500));
    process.exit(1);
  }

  if (!json || !Array.isArray(json.allBundles)) {
    console.error("❌ Unexpected TokPortal response shape.");
    console.error(JSON.stringify(json).slice(0, 500));
    process.exit(1);
  }

  return {
    status: res.status,
    countPublished:
      typeof json.countPublished === "number" ? json.countPublished : null,
    allBundles: json.allBundles,
    raw: json,
  };
}

function summarizeBundle(bundle, index) {
  const possibleId =
    bundle?.id ??
    bundle?._id ??
    bundle?.bundleId ??
    bundle?.uuid ??
    `bundle_${index + 1}`;

  const possibleType =
    bundle?.bundle_type ??
    bundle?.type ??
    bundle?.title ??
    bundle?.name ??
    "Unknown";

  const possiblePrice =
    bundle?.cm_account_price ??
    bundle?.price ??
    bundle?.amount ??
    null;

  return {
    id: String(possibleId),
    type: String(possibleType),
    price: possiblePrice,
    raw: bundle,
  };
}

async function sendDiscordAlert({ countPublished, bundles }) {
  const previewLines = bundles.slice(0, 10).map((bundle, i) => {
    const parts = [`#${i + 1}`, `ID: \`${bundle.id}\``, `Type: ${bundle.type}`];
    if (bundle.price !== null && bundle.price !== undefined) {
      parts.push(`Price: ${bundle.price}`);
    }
    return parts.join(" | ");
  });

  const payload = {
  username: "TokPortal Notifier",
  content: "@everyone 🚨 TOKPORTAL JOB ALERT 🚨",
  embeds: [
      {
        title: "🚨 TokPortal Bundles Available",
        color: 16753920,
        description:
          previewLines.join("\n") ||
          "Bundles detected but details unavailable.",
        fields: [
          {
            name: "Bundle Count",
            value: String(bundles.length),
            inline: true,
          },
          {
            name: "countPublished",
            value:
              countPublished === null ? "unknown" : String(countPublished),
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
    process.exit(1);
  }
}

async function main() {
  console.log("🚀 TokPortal notifier check starting...");

  const result = await fetchAvailableBundles();
  const bundles = result.allBundles;
  const bundleHash = hashBundles(bundles);

  console.log(`HTTP status: ${result.status}`);
  console.log(`countPublished: ${result.countPublished}`);
  console.log(`allBundles.length: ${bundles.length}`);

  if (TEST_MODE) {
    console.log("🧪 TEST MODE ACTIVE — sending test alert");
    await sendDiscordAlert({
      countPublished: result.countPublished,
      bundles: bundles.map(summarizeBundle),
    });
    return;
  }

  if (bundles.length === 0) {
    console.log("CLAY CHECK: 0 bundles — Discord should NOT fire");
    return;
  }

  if (bundleHash === CONFIG.stateHash) {
    console.log("Bundles exist but unchanged.");
    return;
  }

  const summarized = bundles.map(summarizeBundle);
  console.log("New bundle availability detected.");

  await sendDiscordAlert({
    countPublished: result.countPublished,
    bundles: summarized,
  });

  console.log("✅ Discord alert sent.");
  console.log(`LAST_BUNDLE_HASH=${bundleHash}`);
}

async function loop() {
  try {
    await main();
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
  }

  setTimeout(loop, 15000); // check every 15 seconds
}

loop();
