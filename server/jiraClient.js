// A thin, deliberately small client for Jira's REST API — look up one
// issue, search issues by Fix Version, and (internally, cached) resolve the
// "QA Assigned" custom field's id once by name. No writes to Jira are ever
// made.
//
// Every call goes out as a specific signed-in Greenlight user, using that
// user's own Atlassian OAuth access token (see auth/atlassianTokens.js) —
// there is no shared/global Jira credential anywhere in this app. Callers
// never construct a client directly; they get one scoped to the
// authenticated request via forUser(req.authUser), e.g.:
//
//   const jira = jiraClient.forUser(req.authUser);
//   const ticket = await jira.getIssue("MOJ-1234");
//
// Jira Cloud OAuth 2.0 (3LO) tokens can only call the Jira REST API through
// https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/... (the site's
// own https://yourcompany.atlassian.net/rest/api/3/... URL only accepts
// Basic-auth/PAT requests, which this app no longer makes) — see
// auth/atlassianOAuth.js#getCloudId.

const oauth = require("./auth/atlassianOAuth");
const atlassianTokens = require("./auth/atlassianTokens");
const { categorizeStatus } = require("./statusBucket");

class JiraError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "JiraError";
    this.status = status || 502;
  }
}

function apiBase(cloudId) {
  return `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
}

async function jiraFetch(accessToken, cloudId, urlPath, options) {
  const url = `${apiBase(cloudId)}${urlPath}`;
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options && options.headers),
      },
    });
  } catch (e) {
    throw new JiraError(`Couldn't reach Jira (${e.message}). Check your network connection.`, 502);
  }

  if (res.status === 401 || res.status === 403) {
    throw new JiraError("Jira rejected the request (401/403) — your Atlassian authorization may no longer have access to this issue.", res.status);
  }
  if (res.status === 404) {
    throw new JiraError("Not found in Jira (404).", 404);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = (body.errorMessages && body.errorMessages.join("; ")) ||
        (body.errors && JSON.stringify(body.errors)) || "";
    } catch (_) {}
    throw new JiraError(`Jira returned an error (${res.status})${detail ? ": " + detail : "."}`, res.status);
  }
  return res.json();
}

// Jira Cloud (API v3) returns rich-text fields (description, comment bodies)
// as Atlassian Document Format — a nested JSON tree, not plain text. This
// walks it down to plain text so the release-notes summarizer has something
// readable to work with. Older/Server Jira instances may hand back a plain
// string instead, which is passed through as-is.
function adfNodeToText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  const childText = Array.isArray(node.content) ? node.content.map(adfNodeToText).join("") : "";
  const blockTypes = new Set(["paragraph", "heading", "listItem", "codeBlock", "blockquote"]);
  return blockTypes.has(node.type) ? childText + "\n" : childText;
}
function adfToPlainText(doc) {
  if (!doc) return "";
  const text = typeof doc === "string" ? doc : adfNodeToText(doc);
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const TICKET_FIELDS = ["summary", "status", "issuetype", "priority", "description", "resolution", "comment", "fixVersions"];

// A Jira custom field's raw value shape depends on how the field itself was
// set up on this Jira site — a user picker (~{displayName, emailAddress,
// accountId, ...}), a single-select (~{value}), a plain text field (a bare
// string), or a multi-value variant of any of those (an array, in which
// case the first entry wins — "QA Assigned" is conceptually single-owner).
// This normalizes whichever shape shows up down to one display string.
function extractFieldDisplayName(raw) {
  if (raw == null) return "";
  if (Array.isArray(raw)) return raw.length ? extractFieldDisplayName(raw[0]) : "";
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "object") return String(raw.displayName || raw.value || raw.name || "").trim();
  return "";
}

function fieldsToTicket(key, baseUrl, fields, qaAssignedFieldId) {
  const status = (fields && fields.status) || {};
  const statusCategoryKey = status.statusCategory && status.statusCategory.key;
  // A couple of the most recent comments only — enough for the release-notes
  // summarizer to use as a fallback when the description itself is thin,
  // without pulling an entire comment history into every ticket.
  const commentsList = (fields && fields.comment && fields.comment.comments) || [];
  const recentComments = commentsList
    .slice(-2)
    .map((c) => adfToPlainText(c.body))
    .filter(Boolean)
    .join(" ")
    .slice(0, 600);
  const ticket = {
    key,
    url: `${baseUrl.replace(/\/+$/, "")}/browse/${key}`,
    title: (fields && fields.summary) || "Untitled",
    status: status.name || "Unknown",
    bucket: categorizeStatus(status.name, statusCategoryKey),
    issueType: (fields && fields.issuetype && fields.issuetype.name) || "Not provided",
    priority: (fields && fields.priority && fields.priority.name) || "Not provided",
    description: adfToPlainText(fields && fields.description).slice(0, 4000),
    resolution: (fields && fields.resolution && fields.resolution.name) || "",
    recentComments,
  };
  // Only set qaAssignedFromJira when this Jira site actually HAS a "QA
  // Assigned" field (qaAssignedFieldId truthy) — its absence (undefined
  // key, not "") tells the client "we don't know", distinct from "" which
  // means "Jira confirms the field exists but is empty for this issue".
  // The client (public/app.js: ticketEffectiveAssignee/upsertTicket's
  // merge) always prefers a manual override in Greenlight over this value,
  // and this value alone is refreshed on every sync — see
  // routes/releases.js#upsertTicket, which never touches ticket.qaAssignee.
  if (qaAssignedFieldId) {
    ticket.qaAssignedFromJira = extractFieldDisplayName(fields && fields[qaAssignedFieldId]);
  }
  return ticket;
}

// Jira mints a fresh customfield_NNNNN id per site for a custom field like
// "QA Assigned" — there's no fixed id to hardcode. Resolved once by exact
// name match (case-insensitive) via GET /field and cached in memory for the
// life of the process, same rationale as auth/atlassianOAuth.js#getCloudId:
// this deployment only ever talks to one fixed Jira site (one JIRA_SITE_URL
// env var), so the field's id can never change underneath it mid-process.
// null means either this Jira site has no such field, or the lookup itself
// failed (missing scope, transient error) — either way, every sync below
// just proceeds without QA Assigned data rather than failing outright.
let cachedQaAssignedFieldId; // undefined = not looked up yet, null = confirmed absent, string = found
async function getQaAssignedFieldId(accessToken, cloudId) {
  if (cachedQaAssignedFieldId !== undefined) return cachedQaAssignedFieldId;
  try {
    const fields = await jiraFetch(accessToken, cloudId, "/field");
    const match = (Array.isArray(fields) ? fields : []).find(
      (f) => typeof f.name === "string" && f.name.trim().toLowerCase() === "qa assigned"
    );
    cachedQaAssignedFieldId = match ? match.id : null;
  } catch (e) {
    cachedQaAssignedFieldId = null;
  }
  return cachedQaAssignedFieldId;
}

// Resolves the two things every request below needs: this user's current
// access token (refreshing it first if needed — throws ReauthRequiredError
// if that's not possible, see auth/atlassianTokens.js) and this
// deployment's Jira Cloud id (cached in-memory — see
// auth/atlassianOAuth.js#getCloudId). authUser is req.authUser, the
// verified session payload set by auth/middleware.js — always
// { accountId, name, email, avatarUrl }.
async function resolveAuth(authUser) {
  if (!authUser || !authUser.accountId) {
    throw new atlassianTokens.ReauthRequiredError("Sign in with Atlassian to use Jira features.");
  }
  const accessToken = await atlassianTokens.getAccessToken(authUser.accountId);
  const cloudId = await oauth.getCloudId(accessToken);
  return { accessToken, cloudId };
}

// Returns a Jira client scoped to one authenticated Greenlight user — every
// call it makes goes out under that user's own Atlassian OAuth
// authorization, so it only ever sees what that user's own Jira
// permissions allow.
function forUser(authUser) {
  return {
    async getIssue(key) {
      const { accessToken, cloudId } = await resolveAuth(authUser);
      const cfg = oauth.getConfig();
      const qaAssignedFieldId = await getQaAssignedFieldId(accessToken, cloudId);
      const fieldsToFetch = qaAssignedFieldId ? TICKET_FIELDS.concat([qaAssignedFieldId]) : TICKET_FIELDS;
      const data = await jiraFetch(
        accessToken,
        cloudId,
        `/issue/${encodeURIComponent(key)}?fields=${fieldsToFetch.join(",")}`
      );
      return fieldsToTicket(data.key || key, cfg.jiraSiteUrl, data.fields, qaAssignedFieldId);
    },

    // Searches for every issue whose Fix Version/s matches the given version
    // name, paginating through results.
    //
    // Jira retired the classic POST /search endpoint (offset-based
    // startAt/total pagination) in favor of POST /search/jql, which uses
    // cursor/token-based pagination instead: each response carries a
    // `nextPageToken` to pass into the following request, and `isLast` (or
    // an absent/empty issues page) to signal the end. There's no more
    // up-front `total` count from this endpoint.
    async searchByFixVersion(fixVersion) {
      const { accessToken, cloudId } = await resolveAuth(authUser);
      const cfg = oauth.getConfig();
      const qaAssignedFieldId = await getQaAssignedFieldId(accessToken, cloudId);
      const fieldsToFetch = qaAssignedFieldId ? TICKET_FIELDS.concat([qaAssignedFieldId]) : TICKET_FIELDS;
      const jql = `fixVersion = ${JSON.stringify(fixVersion)} ORDER BY key ASC`;
      const pageSize = 100;
      const tickets = [];
      let nextPageToken;

      for (;;) {
        const body = {
          jql,
          maxResults: pageSize,
          fields: fieldsToFetch,
        };
        if (nextPageToken) body.nextPageToken = nextPageToken;

        const page = await jiraFetch(accessToken, cloudId, "/search/jql", {
          method: "POST",
          body: JSON.stringify(body),
        });
        const issues = page.issues || [];
        for (const issue of issues) {
          tickets.push(fieldsToTicket(issue.key, cfg.jiraSiteUrl, issue.fields, qaAssignedFieldId));
        }

        if (!issues.length || page.isLast || !page.nextPageToken) break;
        nextPageToken = page.nextPageToken;
      }

      return { tickets, total: tickets.length };
    },
  };
}

module.exports = { JiraError, forUser };
