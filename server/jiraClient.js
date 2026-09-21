// A thin, deliberately small client for Jira's REST API — just the 3 calls
// Greenlight needs: verify credentials, look up one issue, and search
// issues by Label. No writes to Jira are ever made.

const jiraConfig = require("./jiraConfig");
const { categorizeStatus } = require("./statusBucket");

class JiraError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "JiraError";
    this.status = status || 502;
  }
}

function requireConfig() {
  const cfg = jiraConfig.load();
  if (!cfg || !cfg.baseUrl || !cfg.apiToken) {
    throw new JiraError("Jira isn't connected yet. Add your connection details first.", 409);
  }
  return cfg;
}

function authHeader(cfg) {
  if (cfg.authType === "token") {
    return "Bearer " + cfg.apiToken;
  }
  // Cloud: email + API token, HTTP Basic auth
  const raw = `${cfg.email || ""}:${cfg.apiToken}`;
  return "Basic " + Buffer.from(raw, "utf8").toString("base64");
}

function apiBase(cfg) {
  const version = cfg.apiVersion || "3";
  return `${cfg.baseUrl.replace(/\/+$/, "")}/rest/api/${version}`;
}

async function jiraFetch(cfg, urlPath, options) {
  const url = `${apiBase(cfg)}${urlPath}`;
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        Authorization: authHeader(cfg),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options && options.headers),
      },
    });
  } catch (e) {
    throw new JiraError(
      `Couldn't reach ${cfg.baseUrl} (${e.message}). Check the base URL and your network connection.`,
      502
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new JiraError("Jira rejected the credentials (401/403). Check the email/token or PAT.", res.status);
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

async function testConnection(cfg) {
  const me = await jiraFetch(cfg, "/myself");
  return { displayName: me.displayName || me.name || me.accountId || "Connected" };
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

function fieldsToTicket(key, baseUrl, fields) {
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
  return {
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
}

async function getIssue(key) {
  const cfg = requireConfig();
  const data = await jiraFetch(
    cfg,
    `/issue/${encodeURIComponent(key)}?fields=${TICKET_FIELDS.join(",")}`
  );
  return fieldsToTicket(data.key || key, cfg.baseUrl, data.fields);
}

// Searches for every issue whose Fix Version/s matches the given version
// name, paginating through results.
//
// Jira retired the classic POST /search endpoint (offset-based startAt/total
// pagination) in favor of POST /search/jql, which uses cursor/token-based
// pagination instead: each response carries a `nextPageToken` to pass into
// the following request, and `isLast` (or an absent/empty issues page) to
// signal the end. There's no more up-front `total` count from this endpoint.
async function searchByFixVersion(fixVersion) {
  const cfg = requireConfig();
  const jql = `fixVersion = ${JSON.stringify(fixVersion)} ORDER BY key ASC`;
  const pageSize = 100;
  const tickets = [];
  let nextPageToken;

  for (;;) {
    const body = {
      jql,
      maxResults: pageSize,
      fields: TICKET_FIELDS,
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const page = await jiraFetch(cfg, "/search/jql", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const issues = page.issues || [];
    for (const issue of issues) {
      tickets.push(fieldsToTicket(issue.key, cfg.baseUrl, issue.fields));
    }

    if (!issues.length || page.isLast || !page.nextPageToken) break;
    nextPageToken = page.nextPageToken;
  }

  return { tickets, total: tickets.length };
}

module.exports = { JiraError, testConnection, getIssue, searchByFixVersion };
