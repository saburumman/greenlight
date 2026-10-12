// Validation for the Dependency & Blocker tracker (REPORTING_SPEC.md §4, sheet 9)
// and for saved report presets. Pure functions — the routes call these, the
// store only ever sees cleaned values.

const STATUSES = ["Requested", "In progress", "Received", "Cancelled"];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function validYmd(s) {
  if (!YMD.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

// partial=true (update): only the fields present are validated and returned.
function validateDependency(body, partial) {
  const b = body && typeof body === "object" ? body : {};
  const clean = {};
  const text = (k, label, max, required) => {
    if (b[k] === undefined) { if (required && !partial) return label + " is required."; return null; }
    const v = String(b[k] == null ? "" : b[k]).trim();
    if (required && !v) return label + " is required.";
    if (v.length > max) return label + " is too long (max " + max + " characters).";
    clean[k] = v;
    return null;
  };
  const date = (k, label) => {
    if (b[k] === undefined) return null;
    const v = b[k] === null ? "" : String(b[k]).trim();
    if (!v) { clean[k] = null; return null; }
    if (!validYmd(v)) return label + " must be a date (YYYY-MM-DD).";
    clean[k] = v;
    return null;
  };
  const err = text("entity", "Government entity", 200, true) || text("vendor", "Vendor", 200) || text("needed", "What is needed", 500) || text("owner_name", "Owner", 200)
    || date("promised_date", "Promised date") || date("last_contact_date", "Last contact date") || date("next_followup_date", "Next follow-up date");
  if (err) return { error: err };
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return { error: "Status must be one of: " + STATUSES.join(", ") + "." };
    clean.status = b.status;
  } else if (!partial) clean.status = "Requested";
  return { clean };
}

function validatePresetName(name) {
  const v = String(name == null ? "" : name).trim();
  if (!v) return { error: "Give the preset a name." };
  if (v.length > 60) return { error: "Preset names are limited to 60 characters." };
  return { name: v };
}

module.exports = { STATUSES, validateDependency, validatePresetName, validYmd };
