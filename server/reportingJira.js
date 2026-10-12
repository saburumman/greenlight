// Read-only Jira HTTP layer for the Reporting sync (REPORTING_SPEC.md §2.1).
//
// Authorization is the app's existing model — no shared Jira credential: every
// call goes out under ONE signed-in user's own Atlassian OAuth authorization
// (jiraClient.resolveAuth → auth/atlassianTokens.js), so a sync only ever sees
// what that person's own Jira permissions allow, and a refresh failure
// surfaces as the same ReauthRequiredError the rest of the app already uses.
//
// Only GET and the read-only POST /search/jql are ever issued here. This
// module has no write path to Jira.
//
// Rate limits: 429 / 502 / 503 / 504 and network errors are retried with
// exponential backoff + jitter, honouring Retry-After when Jira sends it.

const { JiraError } = require("./jiraClient");

const RETRYABLE = new Set([429, 502, 503, 504]);

function createJiraHttp(opts) {
  const o = opts || {};
  const getAuth = o.getAuth; // async () => { accessToken, cloudId }
  const fetchImpl = o.fetchImpl || ((...a) => fetch(...a));
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = o.maxRetries === undefined ? 6 : o.maxRetries;
  const baseDelayMs = o.baseDelayMs === undefined ? 1000 : o.baseDelayMs;
  const maxDelayMs = o.maxDelayMs === undefined ? 60000 : o.maxDelayMs;
  const onRetry = o.onRetry || (() => {});
  const stats = { requests: 0, retries: 0 };

  function backoff(attempt, retryAfterHeader) {
    const ra = Number(retryAfterHeader);
    if (retryAfterHeader && isFinite(ra) && ra >= 0) return Math.min(maxDelayMs, ra * 1000);
    const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
    return Math.round(exp / 2 + Math.random() * (exp / 2)); // jitter: half to full
  }

  // Resolves to parsed JSON. `path` is relative to /rest/api/3 .
  async function request(path, init) {
    const method = (init && init.method) || "GET";
    if (method !== "GET" && !(method === "POST" && /^\/search\/jql(\?|$)/.test(path))) {
      throw new Error("Reporting is read-only against Jira: refusing " + method + " " + path);
    }
    for (let attempt = 0; ; attempt++) {
      const { accessToken, cloudId } = await getAuth();
      const url = "https://api.atlassian.com/ex/jira/" + cloudId + "/rest/api/3" + path;
      let res;
      stats.requests++;
      try {
        res = await fetchImpl(url, {
          method,
          headers: { Authorization: "Bearer " + accessToken, Accept: "application/json", "Content-Type": "application/json" },
          body: init && init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
      } catch (e) {
        if (attempt >= maxRetries) throw new JiraError("Couldn't reach Jira (" + e.message + ").", 502);
        const wait = backoff(attempt);
        stats.retries++; onRetry({ attempt, wait, reason: "network" });
        await sleep(wait);
        continue;
      }
      if (RETRYABLE.has(res.status)) {
        if (attempt >= maxRetries) throw new JiraError("Jira kept answering " + res.status + " (rate limit / unavailable) — try again shortly.", res.status);
        const wait = backoff(attempt, res.headers && res.headers.get && res.headers.get("Retry-After"));
        stats.retries++; onRetry({ attempt, wait, reason: String(res.status) });
        await sleep(wait);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new JiraError("Jira rejected the request (" + res.status + ") — this Atlassian authorization can't read that data.", res.status);
      }
      if (res.status === 404) throw new JiraError("Not found in Jira (404): " + path.split("?")[0], 404);
      if (!res.ok) {
        let detail = "";
        try { const b = await res.json(); detail = (b.errorMessages && b.errorMessages.join("; ")) || (b.errors && JSON.stringify(b.errors)) || ""; } catch (_) {}
        throw new JiraError("Jira returned an error (" + res.status + ")" + (detail ? ": " + detail : "."), res.status);
      }
      return res.json();
    }
  }

  return { request, stats };
}

// Pagination helpers over the raw request function --------------------------

// POST /search/jql — cursor pagination (nextPageToken). Calls onPage(issues,
// nextToken) per page so the caller can persist progress; returns the number
// of issues seen.
async function searchJql(http, { jql, fields, expand, pageSize, startToken, onPage }) {
  let token = startToken || undefined;
  let total = 0;
  for (;;) {
    const body = { jql, maxResults: pageSize || 100, fields };
    if (expand) body.expand = expand;
    if (token) body.nextPageToken = token;
    const page = await http.request("/search/jql", { method: "POST", body });
    const issues = page.issues || [];
    total += issues.length;
    const next = !page.isLast && page.nextPageToken && issues.length ? page.nextPageToken : null;
    await onPage(issues, next);
    if (!next) break;
    token = next;
  }
  return total;
}

// Remaining changelog histories for one issue (the search response may carry
// only the first page of them).
async function fetchAllChangelog(http, key) {
  const out = [];
  for (let startAt = 0; ; ) {
    const page = await http.request("/issue/" + encodeURIComponent(key) + "/changelog?startAt=" + startAt + "&maxResults=100");
    const vals = page.values || [];
    out.push(...vals);
    startAt += vals.length;
    if (page.isLast || !vals.length || (page.total != null && startAt >= page.total)) break;
  }
  return out;
}

async function fetchAllWorklogs(http, key) {
  const out = [];
  for (let startAt = 0; ; ) {
    const page = await http.request("/issue/" + encodeURIComponent(key) + "/worklog?startAt=" + startAt + "&maxResults=1000");
    const vals = page.worklogs || [];
    out.push(...vals);
    startAt += vals.length;
    if (!vals.length || startAt >= (page.total || 0)) break;
  }
  return out;
}

module.exports = { createJiraHttp, searchJql, fetchAllChangelog, fetchAllWorklogs };
