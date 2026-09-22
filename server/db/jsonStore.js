// Tiny JSON-file document store. No native dependencies, no database server —
// just a file on disk. This is the original (pre-Postgres) persistence
// layer, kept exactly as it always behaved: it's what server/db.js falls
// back to whenever DATABASE_URL isn't set, so local development and any
// existing non-Supabase deployment keep working with zero setup.
//
// Every exported method is `async` (so the shape matches server/db/pgStore.js
// exactly and routes can always `await` regardless of backend), but the
// underlying implementation is still plain synchronous fs calls — nothing
// about how this behaves has changed.
//
// Shape on disk: { releases: { <id>: {...} }, regressionModules: [{id,name,services:[{id,name}]}],
//                   auditLog: [{id,sessionId,userName,action,entityType,entityId,details,createdAt}],
//                   testData: { <id>: {...} }, team: { <id>: {...} },
//                   atlassianTokens: { <accountId>: {accountId,accessToken,refreshToken,expiresAt,scope,updatedAt} } }
//
// testData is a reusable QA data library — see routes/testData.js. It is
// deliberately its own top-level collection (same shape/pattern as
// `releases`), not nested inside any release, so one record can be reused
// across many releases without duplication.
//
// atlassianTokens holds each signed-in user's own Jira OAuth tokens, keyed
// by their stable Atlassian accountId (never email) — see
// server/auth/atlassianTokens.js. This is the only place any Jira
// access/refresh token is ever persisted; nothing here is ever sent to the
// browser.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

// The master Regression Module list new releases are seeded from — grouped
// as Entity -> Services, matching how the team's real service catalog is
// organized. Editable any time via ⚙ Manage Regression Modules; this is
// just the starting point.
const DEFAULT_REGRESSION_MODULES = [
  { name: "CSPD", services: ["Passport services", "Digital Certificates", "Family Book services"] },
  { name: "DVLD", services: ["Car license services", "Driving License", "Distinguished plate numbers", "Vehicle Enquiry"] },
  { name: "MOE", services: ["All Ajyal services"] },
  { name: "MOJ", services: ["Non Criminal certificate services"] },
  { name: "GAM", services: ["All services"] },
  { name: "DLS", services: ["All services"] },
  { name: "JAF", services: ["All services"] },
  { name: "MODEE", services: ["Electronic Gate"] },
  { name: "PSD", services: ["Permit Travel"] },
  { name: "SSC", services: ["All services"] },
  { name: "MOLA", services: ["Property tax Inquery"] },
  { name: "GID", services: ["All services"] },
  { name: "CRIF", services: ["All services"] },
  { name: "CCD", services: ["Enquiry for company"] },
  { name: "MOHE", services: ["All services"] },
  { name: "Jordan Post", services: ["Jordan Post Box", "Create Digital PO Box"] },
  { name: "EMRC", services: ["All Services"] },
].map((entity) => ({
  id: crypto.randomUUID(),
  name: entity.name,
  services: entity.services.map((name) => ({ id: crypto.randomUUID(), name })),
}));

// Starter "Know the Team" roster — shown only until a real team replaces it.
// `seeded: true` marks these as starter entries (rendered with a small
// "Example" badge on the client); saving any edit to one clears the flag.
// No invented personal details beyond what's already been confirmed.
function buildDefaultTeam() {
  const now = new Date().toISOString();
  return [
    {
      name: "Saraa Abu-Rumman",
      role: "QA Team Lead",
      department: "QA",
      bio: "",
      specialties: ["Automation", "QA Strategy", "Release Quality"],
      tools: [],
      linkedin: "",
      github: "",
      photo: "",
      seeded: true,
    },
    {
      name: "Team Member",
      role: "Senior QA Engineer",
      department: "QA",
      bio: "",
      specialties: ["Manual Testing", "Automation", "API Testing"],
      tools: [],
      linkedin: "",
      github: "",
      photo: "",
      seeded: true,
    },
  ].reduce((map, member) => {
    const id = crypto.randomUUID();
    map[id] = { id, ...member, createdBy: "Seed", createdAt: now, updatedAt: now };
    return map;
  }, {});
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify(
        {
          releases: {},
          regressionModules: DEFAULT_REGRESSION_MODULES,
          auditLog: [],
          testData: {},
          team: buildDefaultTeam(),
          atlassianTokens: {},
        },
        null,
        2
      )
    );
  }
}

function readAll() {
  ensureStore();
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    let dirty = false;
    if (!parsed.releases) {
      parsed.releases = {};
      dirty = true;
    }
    const isLegacyFlatList =
      Array.isArray(parsed.regressionModules) &&
      parsed.regressionModules.length > 0 &&
      parsed.regressionModules.some((m) => !Array.isArray(m.services));
    if (!parsed.regressionModules || isLegacyFlatList) {
      // Either this store predates the regression-modules feature entirely,
      // or it predates the Entity -> Services grouping (a flat module-name
      // list). Either way, seed/replace with the current Entity/Service
      // default list. This only touches the master list — any release
      // that already exists keeps its own regression data untouched (see
      // regressionEntities() in the frontend for how older, flat release
      // data still displays and edits correctly).
      parsed.regressionModules = DEFAULT_REGRESSION_MODULES;
      dirty = true;
    }
    // Additive: stores created before the Audit Log feature existed just
    // get an empty log to start appending to — nothing else about them
    // changes.
    if (!Array.isArray(parsed.auditLog)) {
      parsed.auditLog = [];
      dirty = true;
    }
    // Additive: stores created before the Test Data feature existed just
    // get an empty collection — nothing else about them changes.
    if (!parsed.testData || typeof parsed.testData !== "object" || Array.isArray(parsed.testData)) {
      parsed.testData = {};
      dirty = true;
    }
    // Additive: Test Data records saved before Entity became a multi-value
    // field carry a single `entity` string — convert each to the new
    // `entities` array (dropping the old key) so every record has a
    // consistent shape going forward. Nothing else about the record changes.
    for (const rec of Object.values(parsed.testData)) {
      if (rec && !Array.isArray(rec.entities) && typeof rec.entity === "string") {
        rec.entities = rec.entity ? [rec.entity] : [];
        delete rec.entity;
        dirty = true;
      }
    }
    // Additive: stores created before "Know the Team" existed get the
    // starter roster (see buildDefaultTeam) — nothing else about them
    // changes, and this only runs once (the empty object it starts from
    // never reappears once at least one member has been saved).
    if (!parsed.team || typeof parsed.team !== "object" || Array.isArray(parsed.team)) {
      parsed.team = buildDefaultTeam();
      dirty = true;
    }
    // Additive: stores created before per-user Atlassian OAuth existed just
    // get an empty token collection — nothing else about them changes.
    if (!parsed.atlassianTokens || typeof parsed.atlassianTokens !== "object" || Array.isArray(parsed.atlassianTokens)) {
      parsed.atlassianTokens = {};
      dirty = true;
    }
    // Additive: regression entities saved before the per-release "Owner"
    // field existed just get an empty owner — nothing else about them
    // changes. A legacy flat regression row (no `services` array) counts
    // too, so an old release can still have an owner assigned to it.
    for (const rel of Object.values(parsed.releases || {})) {
      for (const entity of rel.regression || []) {
        if (entity && typeof entity.owner !== "string") {
          entity.owner = "";
          dirty = true;
        }
      }
    }
    if (dirty) writeAll(parsed);
    return parsed;
  } catch (e) {
    // Corrupt file — back it up rather than silently losing data.
    const backupPath = STORE_PATH + ".corrupt." + Date.now();
    try {
      fs.copyFileSync(STORE_PATH, backupPath);
    } catch (_) {}
    const fresh = {
      releases: {},
      regressionModules: DEFAULT_REGRESSION_MODULES,
      auditLog: [],
      testData: {},
      team: buildDefaultTeam(),
      atlassianTokens: {},
    };
    fs.writeFileSync(STORE_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

function writeAll(data) {
  ensureStore();
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

const releases = {
  async list() {
    const data = readAll();
    // Newest-created first, and stays put as you edit it — sorting by
    // updatedAt instead would reshuffle the whole list every time any field
    // on any release changes (e.g. flipping a regression status), which
    // reads as random rather than "newest first".
    return Object.values(data.releases).sort((a, b) =>
      String(b.createdAt || b.updatedAt || "").localeCompare(String(a.createdAt || a.updatedAt || ""))
    );
  },
  async get(id) {
    const data = readAll();
    return data.releases[id] || null;
  },
  async set(id, release) {
    const data = readAll();
    data.releases[id] = release;
    writeAll(data);
    return release;
  },
  async delete(id) {
    const data = readAll();
    delete data.releases[id];
    writeAll(data);
  },
};

// The reusable master list of regression modules. New releases take a
// snapshot of this list at creation time (see routes/releases.js); editing
// it here never retroactively changes any release that already exists.
const regressionModules = {
  async list() {
    const data = readAll();
    return data.regressionModules || [];
  },
  async set(modules) {
    const data = readAll();
    data.regressionModules = modules;
    writeAll(data);
    return modules;
  },
};

// Append-only Audit Log — a record of meaningful, guest-attributed actions
// (see routes/audit.js). Never edited or removed via the app; purely
// additive, same storage file as everything else.
const auditLog = {
  async list() {
    const data = readAll();
    // Newest first, for the Audit Log page.
    return (data.auditLog || []).slice().sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
    );
  },
  async append(entry) {
    const data = readAll();
    data.auditLog = data.auditLog || [];
    // Idempotency guard: if a record with this id was already written (e.g.
    // a retried request), return the existing one instead of duplicating it.
    const already = entry.id && data.auditLog.find((e) => e.id === entry.id);
    if (already) return already;
    data.auditLog.push(entry);
    writeAll(data);
    return entry;
  },
};

// Reusable QA Test Data library — independent of any release (see
// routes/testData.js). Same list/get/set/delete shape as `releases` above.
const testData = {
  async list() {
    const data = readAll();
    // Newest-created first, same convention as releases.list().
    return Object.values(data.testData).sort((a, b) =>
      String(b.createdAt || b.updatedAt || "").localeCompare(String(a.createdAt || a.updatedAt || ""))
    );
  },
  async get(id) {
    const data = readAll();
    return data.testData[id] || null;
  },
  async set(id, record) {
    const data = readAll();
    data.testData[id] = record;
    writeAll(data);
    return record;
  },
  async delete(id) {
    const data = readAll();
    delete data.testData[id];
    writeAll(data);
  },
};

// "Know the Team" roster — independent of releases, same list/get/set/delete
// shape as `testData`. Starts from buildDefaultTeam()'s starter entries (see
// above); every entry is freely editable and deletable from the UI, this is
// not a locked-down config.
const team = {
  async list() {
    const data = readAll();
    // Newest-created first, same convention as releases/testData — new
    // members show up at the top rather than at the bottom of the grid.
    return Object.values(data.team).sort((a, b) =>
      String(b.createdAt || b.updatedAt || "").localeCompare(String(a.createdAt || a.updatedAt || ""))
    );
  },
  async get(id) {
    const data = readAll();
    return data.team[id] || null;
  },
  async set(id, member) {
    const data = readAll();
    data.team[id] = member;
    writeAll(data);
    return member;
  },
  async delete(id) {
    const data = readAll();
    delete data.team[id];
    writeAll(data);
  },
};

// Per-user Atlassian OAuth token storage — keyed by accountId, never email
// (see server/auth/atlassianTokens.js, which is the only other module that
// touches this collection). Same get/set/delete shape as the collections
// above, minus list() — nothing needs "all stored tokens" as a set.
const atlassianTokens = {
  async get(accountId) {
    const data = readAll();
    return data.atlassianTokens[accountId] || null;
  },
  async set(accountId, record) {
    const data = readAll();
    data.atlassianTokens[accountId] = record;
    writeAll(data);
    return record;
  },
  async delete(accountId) {
    const data = readAll();
    delete data.atlassianTokens[accountId];
    writeAll(data);
  },
};

module.exports = {
  releases,
  regressionModules,
  auditLog,
  testData,
  team,
  atlassianTokens,
  DEFAULT_REGRESSION_MODULES,
  buildDefaultTeam,
};
