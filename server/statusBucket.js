// Maps an arbitrary Jira workflow status onto the 4 buckets Greenlight
// summarizes tickets into: "Open / To Do", "In QA", "Blocked", "Completed".
//
// Jira ships a reliable built-in classification (fields.status.statusCategory.key:
// "new" | "indeterminate" | "done") but that's too coarse to separate "In QA"
// or "Blocked" out of "indeterminate" — those are workflow-specific status
// names, so we pattern-match the status name for them. Tune the regexes below
// if your team's workflow uses different status names.

function categorizeStatus(statusName, statusCategoryKey) {
  const name = String(statusName || "").toLowerCase();

  if (statusCategoryKey === "done") return "Completed";
  if (/block/i.test(name)) return "Blocked";
  if (/\bqa\b|quality assurance|\btest/i.test(name)) return "In QA";
  if (statusCategoryKey === "new") return "Open / To Do";
  // Any other "in progress"-style status (in review, in development, ...)
  // still counts as open work rather than done.
  return "Open / To Do";
}

module.exports = { categorizeStatus };
