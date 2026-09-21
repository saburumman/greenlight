// Stores your Jira connection details in a local file (data/jira-config.json),
// on THIS machine only. The API token never goes back to the browser —
// routes/jira.js only ever returns whether a connection is configured, plus
// non-secret fields (base URL, account name).

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "jira-config.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    return null;
  }
}

/**
 * config: {
 *   baseUrl: "https://yourcompany.atlassian.net",
 *   authType: "cloud" | "token",   // cloud = email + API token (Basic auth); token = PAT (Bearer), for Server/Data Center
 *   email: "you@company.com",       // required for authType "cloud"
 *   apiToken: "...",
 *   apiVersion: "3" | "2"           // Jira REST API version; Cloud is 3, many Server/DC instances are 2
 * }
 */
function save(config) {
  ensureDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function clear() {
  ensureDir();
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
}

// Never expose the token — this is what's safe to send to the browser.
function publicView() {
  const cfg = load();
  if (!cfg) return { configured: false };
  return {
    configured: true,
    baseUrl: cfg.baseUrl,
    authType: cfg.authType,
    email: cfg.authType === "cloud" ? cfg.email : undefined,
  };
}

module.exports = { load, save, clear, publicView };
