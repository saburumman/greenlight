// Pulls a Jira issue key (e.g. "MOJ-1234") out of a pasted URL or raw string.
function extractIssueKey(input) {
  if (!input) return null;
  const match = String(input).match(/([A-Za-z][A-Za-z0-9_]*-\d+)/);
  return match ? match[1].toUpperCase() : null;
}

module.exports = { extractIssueKey };
