// The Daily QA Update reminder: ONE Slack message a day at 3:45 PM Asia/Amman,
// separate from the reports themselves. It only reminds — it never names
// anyone and never implies a report has been submitted.
//
// A once-a-minute timer checks the Amman clock. The day is "claimed" in the
// database before posting, so a restart (or a second instance) can't send it
// twice; if the Slack post fails the claim is given back and the next tick
// tries again (at most once every few minutes) until the grace window closes.
// Nothing runs when Slack isn't configured.

const db = require("./db");
const slack = require("./slack");
const logic = require("./dailyReportLogic");

const TICK_MS = 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

let timer = null;
let lastFailureAt = 0;

// One check. `now` is injectable for tests. -> { sent } | { skipped: reason } | { failed: error }
async function tick(now) {
  const at = now instanceof Date ? now : new Date(now || Date.now());
  if (!slack.isConfigured("reminder")) return { skipped: "not_configured" };
  if (!logic.reminderDue(at)) return { skipped: "not_due" };
  if (lastFailureAt && at.getTime() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return { skipped: "backing_off" };
  const date = logic.reportDateFor(at);
  if (!(await db.dailyReminders.claim(date))) return { skipped: "already_sent" };
  const result = await slack.sendMessage(logic.buildReminderMessage(process.env.APP_BASE_URL), { kind: "reminder" });
  if (!result.ok) {
    lastFailureAt = at.getTime();
    await db.dailyReminders.release(date); // not sent -> try again on a later tick
    return { failed: result.error };
  }
  lastFailureAt = 0;
  return { sent: true, date };
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    tick().then((r) => {
      if (r && r.failed) console.error("daily QA reminder not sent: " + r.failed);
      else if (r && r.sent) console.log("  Daily QA reminder sent for " + r.date);
    }).catch((e) => console.error("daily QA reminder:", e && e.message));
  }, TICK_MS);
  if (timer.unref) timer.unref();
}
function __reset() { lastFailureAt = 0; }

module.exports = { tick, start, __reset };
