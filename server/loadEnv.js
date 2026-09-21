// Minimal .env loader — deliberately hand-rolled instead of adding the
// `dotenv` dependency, matching this project's near-zero-dependency style.
//
// Docker gets its env vars automatically via docker-compose's `env_file:`,
// so this file is a no-op there. It only matters for running locally with
// `npm start` / `npm run dev` (they're the same command — see package.json):
// without this, a `.env` file sitting in the project root does nothing by
// itself, since plain `node`/npm scripts never read it on their own.

const fs = require("fs");
const path = require("path");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // A real environment variable (shell export, Docker) always wins over
    // whatever is in .env — this file only fills in gaps.
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

module.exports = { loadEnv };
