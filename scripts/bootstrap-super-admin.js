#!/usr/bin/env node
// Operator tool: makes one Jira account the (first) Super Admin.
//
// This is the "break glass" / first-setup path next to the SUPER_ADMIN_ACCOUNT_IDS
// environment variable. It talks to the database directly, so only someone who
// already controls the server (its shell or its DATABASE_URL) can use it — there
// is no web endpoint that can grant administrative rights.
//
// Usage:
//   node scripts/bootstrap-super-admin.js <jiraAccountId> [--name "Display Name"] [--force]
//   npm run admin:bootstrap -- <jiraAccountId>
//
// Without --force it refuses when an active Super Admin already exists.
// Find a Jira account id: it is shown on the "waiting for access" screen after
// signing in, or in the profile URL  https://<site>.atlassian.net/jira/people/<accountId>.

require("../server/loadEnv").loadEnv();
const rbac = require("../server/rbacService");

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const nameIdx = args.indexOf("--name");
  const displayName = nameIdx > -1 ? args[nameIdx + 1] : "";
  const accountId = args.find((a, i) => !a.startsWith("--") && !(nameIdx > -1 && i === nameIdx + 1));
  if (!accountId) {
    console.error('Usage: node scripts/bootstrap-super-admin.js <jiraAccountId> [--name "Display Name"] [--force]');
    process.exit(1);
  }
  try {
    const user = await rbac.bootstrapSuperAdmin(accountId, { force, displayName });
    console.log("Done: " + (user.displayName || user.accountId) + " is now an active Super Admin.");
    console.log("They keep signing in with their own Jira account as usual.");
    process.exit(0);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}
main();
