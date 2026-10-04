// One-time (idempotent) startup migration: rewrites every stored release so
// QA assignments reference Know the Team member ids instead of display
// names (see assignmentLogic.migrateReleaseAssignments for the rules and for
// what's preserved when a name can't be matched). Running it at startup —
// rather than only lazily when a release is next saved — pins each old name
// to the member it matched TODAY, so later renaming someone in Know the Team
// can't change who an old assignment points at.
//
// Never throws and never blocks startup: a failure is logged and the app
// keeps working (every read also converts in memory, see routes/releases.js).

const assignmentLogic = require("./assignmentLogic");

async function migrateAllReleases(db) {
  try {
    const team = await db.team.list();
    const releases = await db.releases.list();
    let migrated = 0;
    for (const release of releases) {
      if (assignmentLogic.migrateReleaseAssignments(release, team)) {
        await db.releases.set(release._id, release);
        migrated += 1;
      }
    }
    return migrated;
  } catch (e) {
    console.error("  Assignment migration skipped:", e && e.message);
    return 0;
  }
}

module.exports = { migrateAllReleases };
