(function(){
"use strict";

/* ============================================================
   CONSTANTS
   ============================================================ */
var REG_STATUSES = ["PASS","WARNING","FAIL","NOT TESTED","SKIP"];
var BUG_SEVERITIES = ["Critical","High","Medium","Low"];
var BUG_STATUSES = ["Open","Resolved","Deferred"];
var PLATFORM_STATUSES = ["PASS","WARNING","FAIL","NOT TESTED"];
var BLOCKER_STATUSES = ["Open","In Progress","Resolved"];
var INCIDENT_SEVERITIES = ["Critical","High","Medium","Low"];
var INCIDENT_STATUSES = ["Open","Investigating","Resolved"];
// Labels for the Incident Type choice in the Add/Edit modal — mapped to the
// stored scope ("TICKET" / "RELEASE") by incidentScopeFromType below.
var INCIDENT_TYPE_TICKET = "Related to a ticket";
var INCIDENT_TYPE_RELEASE = "Release-level incident";
var PERF_STATUSES = ["PASS","WARNING","FAIL"];
var SEC_STATUSES = ["PASS","WARNING","FAIL"];
var PLATFORM_LABELS = {web:"Web", android:"Android", ios:"iOS"};
var TICKET_BUCKETS = ["Open / To Do","In QA","Blocked","Completed"];
var TICKET_STATUS_OPTIONS = ["Open / To Do","In Progress","In QA","Blocked","Completed"];
var TICKET_GROUP_MODES = ["QA Assignee","None","Status","Priority","Issue Type"];
var REGRESSION_GROUP_MODES = ["Entity","Owner"];

function toneForStatus(s){
  // Fixed status-color convention: PASS=green, FAIL=red, WARNING=yellow,
  // NOT TESTED=blue, SKIP=grey (the default "neutral" tone) — used both for
  // pills and for the checked state of status-choice buttons.
  if(s==="PASS"||s==="GO"||s==="Resolved"||s==="Completed") return "go";
  if(s==="WARNING"||s==="CONDITIONAL GO"||s==="In Progress"||s==="Investigating"||s==="Deferred"||s==="High") return "warn";
  if(s==="FAIL"||s==="NO-GO"||s==="Open"||s==="Critical"||s==="Blocked") return "danger";
  if(s==="Medium"||s==="In QA"||s==="NOT TESTED") return "info";
  return "neutral"; // includes SKIP
}

/* ============================================================
   UTIL
   ============================================================ */
function esc(s){
  return String(s==null?"":s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}
function escAttr(s){ return esc(s); }
function qs(sel, root){ return (root||document).querySelector(sel); }
function qsa(sel, root){ return Array.prototype.slice.call((root||document).querySelectorAll(sel)); }
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function num(v){ var n = parseFloat(v); return isNaN(n) ? 0 : n; }
function pluralize(n, s, p){ return n===1 ? s : (p||s+"s"); }
function fmtDate(d){
  if(!d) return "Not provided";
  var parts = d.split("-");
  if(parts.length!==3) return d;
  var months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var m = parseInt(parts[1],10)-1;
  return months[m]+" "+parseInt(parts[2],10)+", "+parts[0];
}
function fmtDateTime(iso){
  if(!iso) return null;
  var d = new Date(iso);
  if(isNaN(d.getTime())) return null;
  var months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var h = d.getHours(); var ampm = h>=12?"PM":"AM"; var h12 = h%12; if(h12===0) h12=12;
  var mm = d.getMinutes(); var mmStr = mm<10?"0"+mm:""+mm;
  return d.getDate()+" "+months[d.getMonth()]+" "+d.getFullYear()+", "+h12+":"+mmStr+" "+ampm;
}
function fmtRelativeTime(iso){
  // Compact "x ago" phrasing for compact landing-page rows — falls back to
  // an absolute date once it's more than a few weeks old, same as most
  // activity feeds.
  if(!iso) return "";
  var d = new Date(iso);
  if(isNaN(d.getTime())) return "";
  var mins = Math.round((Date.now()-d.getTime())/60000);
  if(mins < 1) return "just now";
  if(mins < 60) return mins+" min"+(mins===1?"":"s")+" ago";
  var hours = Math.round(mins/60);
  if(hours < 24) return hours+" hour"+(hours===1?"":"s")+" ago";
  var days = Math.round(hours/24);
  if(days < 7) return days+" day"+(days===1?"":"s")+" ago";
  var weeks = Math.round(days/7);
  if(weeks < 5) return weeks+" week"+(weeks===1?"":"s")+" ago";
  return fmtDate(iso.slice(0,10));
}
function showToast(msg){
  var root = qs("#toast-root");
  var t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(function(){ t.remove(); }, 3200);
}
function anyFieldFocused(){
  var a = document.activeElement;
  if(!a) return false;
  var tag = a.tagName;
  return tag==="INPUT" || tag==="TEXTAREA" || a.isContentEditable;
}

/* ============================================================
   API LAYER
   ============================================================ */
var API = "/api";
function apiCall(method, path, body){
  return fetch(API+path, {
    method: method,
    headers: body!==undefined ? {"Content-Type":"application/json"} : undefined,
    body: body!==undefined ? JSON.stringify(body) : undefined
  }).then(function(res){
    return res.json().catch(function(){ return {}; }).then(function(data){
      if(res.status===401 && data && data.loginUrl){
        // Session expired (or Atlassian login is required and we somehow
        // got here without one) — bounce to sign-in rather than showing a
        // generic error. Navigating away, so this promise deliberately
        // never resolves.
        location.href = data.loginUrl;
        return new Promise(function(){});
      }
      if(!res.ok){
        var err = new Error(data.error || ("Request failed ("+res.status+")"));
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    });
  });
}
// Separate from apiCall since these live at /auth/*, not /api/* — no
// session required to call them (that's the point of /auth/me).
function authCall(method, path, body){
  return fetch(path, {
    method: method,
    headers: body!==undefined ? {"Content-Type":"application/json"} : undefined,
    body: body!==undefined ? JSON.stringify(body) : undefined
  }).then(function(res){
    return res.json().catch(function(){ return {}; }).then(function(data){
      if(!res.ok){
        var err = new Error(data.error || ("Request failed ("+res.status+")"));
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    });
  });
}
var authApi = {
  me: function(){ return authCall("GET","/auth/me"); },
  logout: function(){ return authCall("POST","/auth/logout"); }
};
var api = {
  listReleases: function(){ return apiCall("GET","/releases"); },
  getRelease: function(id){ return apiCall("GET","/releases/"+id); },
  createRelease: function(data){ return apiCall("POST","/releases", data); },
  saveRelease: function(id, data){ return apiCall("PUT","/releases/"+id, data); },
  deleteRelease: function(id){ return apiCall("DELETE","/releases/"+id); },
  duplicateRelease: function(id){ return apiCall("POST","/releases/"+id+"/duplicate"); },
  addTicket: function(id, data){ return apiCall("POST","/releases/"+id+"/tickets", data); },
  deleteTicket: function(id, key){ return apiCall("DELETE","/releases/"+id+"/tickets/"+encodeURIComponent(key)); },
  jiraSync: function(id){ return apiCall("POST","/releases/"+id+"/jira-sync"); },
  generateReleaseNotes: function(id){ return apiCall("POST","/releases/"+id+"/release-notes/generate"); },
  draftMobileNoteEn: function(id, ticketKeys){ return apiCall("POST","/releases/"+id+"/mobile-release-note/draft-en", {ticketKeys: ticketKeys||[]}); },
  translateMobileNoteAr: function(id, enUS){ return apiCall("POST","/releases/"+id+"/mobile-release-note/translate-ar", {enUS:enUS}); },
  syncRegressionModules: function(id){ return apiCall("POST","/releases/"+id+"/regression-sync"); },
  jiraStatus: function(){ return apiCall("GET","/jira/status"); },
  listRegressionModules: function(){ return apiCall("GET","/regression-modules"); },
  saveRegressionModules: function(list){ return apiCall("PUT","/regression-modules", list); },
  listAudit: function(){ return apiCall("GET","/audit"); },
  logAuditEvent: function(data){ return apiCall("POST","/audit", data); },
  listTestData: function(){ return apiCall("GET","/test-data"); },
  createTestData: function(data){ return apiCall("POST","/test-data", data); },
  bulkImportTestData: function(records){ return apiCall("POST","/test-data/bulk", {records:records}); },
  updateTestData: function(id, data){ return apiCall("PUT","/test-data/"+id, data); },
  deleteTestData: function(id){ return apiCall("DELETE","/test-data/"+id); },
  listTeam: function(){ return apiCall("GET","/team"); },
  createTeamMember: function(data){ return apiCall("POST","/team", data); },
  updateTeamMember: function(id, data){ return apiCall("PUT","/team/"+id, data); },
  deleteTeamMember: function(id){ return apiCall("DELETE","/team/"+id); },
  linkMeToTeamMember: function(id, linked){ return apiCall("PUT","/team/"+id+"/link-me", {linked: !!linked}); }
};

/* ============================================================
   AUDIT LOG (client side)
   A thin, reusable logger — every call-site just says what happened and the
   SERVER fills in who (the signed-in account, resolved to its Know the Team
   member id) and when; nothing about identity is sent from here, so it can't
   be spoofed. Best-effort and fire-and-forget: a failed audit write never
   blocks the actual user action. Assignment changes and regression status
   changes are not logged from here at all — the server derives them from the
   release save itself (see server/assignmentLogic.js), where it knows both
   the before/after state and who acted.
   ============================================================ */
function logAudit(opts){
  try{
    var payload = {
      id: crypto.randomUUID(), // lets a retried request be deduped server-side
      action: opts.action,
      entityType: opts.entityType || "",
      entityId: opts.entityId || "",
      details: opts.details || ""
    };
    api.logAuditEvent(payload).catch(function(){ /* activity tracking only — never surfaced to the user */ });
  }catch(e){ /* never let audit logging break the actual action */ }
}

/* ============================================================
   STATE
   ============================================================ */
var state = {
  route: {view:"list"},
  releases: {},
  releaseOrder: [],
  listReady: false,
  loadError: null,
  jiraStatus: {connected:false},
  notesDirty: false,
  mobileNoteDirty: false, // unsaved-edit flag for the Mobile Release Note textareas — same pattern as notesDirty above
  ticketGroupBy: "QA Assignee", // default grouping for the Tickets section — see groupTickets
  ticketCollapsed: {}, // groupKey -> true if collapsed
  regressionGroupBy: "Entity", // "Entity" (default list) or "Owner" (bucketed by assignee, see sectionRegression)
  regressionView: "All", // "All" | "Mine" | "Unassigned" — see filterRegressionEntitiesForView
  statsFilters: null, // Statistics page filters {range, from, to, releaseId, memberId} — created on first visit (see statsDefaultFilters)
  incidentFilters: {}, // releaseId -> {scope:"All"|"TICKET"|"RELEASE", severity, status} — the Incidents section's lightweight filters (see incidentFilterFor)
  pendingScrollTo: null, // section id to scroll to right after the next detail render (e.g. from a search result)
  searchQuery: "",
  searchResults: [],
  searchActiveIndex: -1,
  auth: {authenticated:false, user:null}, // from /auth/me — see initAuthThenBoot()
  blockingModal: false, // true while the sign-in modal is open
  auditLog: [],
  auditReady: false,
  assessmentLoggedFor: {}, // releaseId -> true, so AI_ASSESSMENT_GENERATED logs once per viewing, not every re-render
  // ---- Test Data — a reusable QA data library, independent of any release
  // (see renderTestData() and friends) ----
  testData: {}, // id -> record
  testDataOrder: [], // ids, newest-created first (as the API returns them)
  testDataReady: false,
  testDataSearch: "",
  testDataEntityFilter: "", // empty = no filter — these are now searchable text inputs, not fixed dropdowns
  testDataTagFilter: "",
  testDataPage: 1, // 1-based; reset to 1 whenever search/entity/tag filters change
  // ---- Know the Team — a small editable roster, independent of releases
  // and of the auth system (see renderTeam() and friends) ----
  team: {}, // id -> member
  teamOrder: [], // ids, newest-created first (as the API returns them)
  teamReady: false
};

/* ============================================================
   AI ASSESSMENT ENGINE
   Priority order (per spec): 1 release blockers, 2 critical/high bugs,
   3 failed regression modules, 4 blocked tickets, 5 platform failures,
   6 other warnings (performance, security, misc). Ticket count alone
   never determines GO/NO-GO — only used as one input among several.
   ============================================================ */
function computeAssessment(r){
  var factors = { nogo:[], conditional:[] };
  var risks = [];
  var tickets = r.tickets || [];

  var blockersOpen = (r.blockers||[]).filter(function(b){return b.status==="Open";});
  var blockersProgress = (r.blockers||[]).filter(function(b){return b.status==="In Progress";});
  var bugsCriticalOpen = (r.bugs||[]).filter(function(b){return b.severity==="Critical" && b.status==="Open";});
  var bugsHighOpen = (r.bugs||[]).filter(function(b){return b.severity==="High" && b.status==="Open";});
  var regSkipped = !!r.regressionSkipped;
  var regItems = regressionAllServices(r);
  var regFail = regItems.filter(function(m){return m.status==="FAIL";});
  var regWarn = regItems.filter(function(m){return m.status==="WARNING";});
  var regNotTested = regItems.filter(function(m){return m.status==="NOT TESTED";});
  var blockedTickets = tickets.filter(function(t){return t.bucket==="Blocked";});
  var platEntries = ["web","android","ios"].map(function(k){return {key:k, label:PLATFORM_LABELS[k], v:r.platforms[k]};});
  var platFail = platEntries.filter(function(p){return p.v.status==="FAIL";});
  var platWarn = platEntries.filter(function(p){return p.v.status==="WARNING";});
  var perfOn = !!r.performance.enabled;
  var perfFail = perfOn && r.performance.status==="FAIL";
  var perfWarn = perfOn && r.performance.status==="WARNING";
  var secOn = !!r.security.enabled;
  var secCriticalOpen = secOn && num(r.security.critical) > 0;
  var secHighOpen = secOn && num(r.security.high) > 0;
  var secFailStatus = secOn && r.security.status==="FAIL";
  // Incidents are a risk signal, never a verdict on their own: an unresolved
  // Critical one is a NO-GO factor (like an open critical bug), an unresolved
  // High one a conditional factor, and anything already Resolved — or any
  // unresolved Medium/Low — is only mentioned for context. "Unresolved" means
  // not Resolved, so an incident that's still being Investigated counts.
  var incidents = r.incidents||[];
  var incActive = incidents.filter(incidentIsUnresolved);
  var incCriticalActive = incActive.filter(function(i){return i.severity==="Critical";});
  var incHighActive = incActive.filter(function(i){return i.severity==="High";});
  var incMinorActive = incActive.filter(function(i){return i.severity!=="Critical" && i.severity!=="High";});
  var incSevereResolved = incidents.filter(function(i){return !incidentIsUnresolved(i) && (i.severity==="Critical"||i.severity==="High");});

  var hasAnyData = regItems.length || regSkipped || (r.bugs||[]).length || (r.blockers||[]).length || incidents.length ||
    tickets.length || perfOn || secOn ||
    ["web","android","ios"].some(function(k){return r.platforms[k].status!=="NOT TESTED";});

  // ---- 1. Release Blockers ----
  if(blockersOpen.length){
    factors.nogo.push("blockersOpen");
    blockersOpen.forEach(function(b){
      risks.push({tone:"danger", text:"Open blocker — <b>"+esc(b.title||"Untitled")+"</b>"+(b.owner? " (owner: "+esc(b.owner)+")":"")});
    });
  }
  if(blockersProgress.length && !blockersOpen.length){
    factors.conditional.push("blockersProgress");
    risks.push({tone:"warn", text: blockersProgress.length+" release blocker"+pluralize(blockersProgress.length,"","s")+" still in progress"});
  }

  // ---- 2. Critical / High bugs ----
  if(bugsCriticalOpen.length){
    factors.nogo.push("bugsCritical");
    risks.push({tone:"danger", text: bugsCriticalOpen.length+" critical bug"+pluralize(bugsCriticalOpen.length,"","s")+" open"});
  }
  if(bugsHighOpen.length){
    factors.conditional.push("bugsHigh");
    risks.push({tone:"warn", text: bugsHighOpen.length+" high-severity bug"+pluralize(bugsHighOpen.length,"","s")+" open"});
  }

  // ---- 2b. Incidents ----
  if(incCriticalActive.length){
    factors.nogo.push("incidentCritical");
    risks.push({tone:"danger", text: incCriticalActive.length+" critical incident"+pluralize(incCriticalActive.length,"","s")+" unresolved: "+incidentTitlesText(r, incCriticalActive)});
  }
  if(incHighActive.length){
    factors.conditional.push("incidentHigh");
    risks.push({tone:"warn", text: incHighActive.length+" high-severity incident"+pluralize(incHighActive.length,"","s")+" unresolved: "+incidentTitlesText(r, incHighActive)});
  }
  if(incSevereResolved.length){
    risks.push({tone:"neutral", text: incSevereResolved.length+" critical/high incident"+pluralize(incSevereResolved.length,"","s")+" resolved before release: "+incidentTitlesText(r, incSevereResolved)});
  }
  if(incMinorActive.length){
    risks.push({tone:"neutral", text: incMinorActive.length+" medium/low incident"+pluralize(incMinorActive.length,"","s")+" still unresolved"});
  }

  // ---- 3. Regression ----
  var regApplicable = regItems.filter(function(m){return m.status!=="SKIP";});
  if(regSkipped){
    risks.push({tone:"neutral", text:"Regression testing was marked as not required for this release"});
  } else if(!regItems.length){
    factors.conditional.push("regNotStarted");
    risks.push({tone:"warn", text:"Regression testing has not been started for this release"});
  } else if(!regApplicable.length){
    risks.push({tone:"neutral", text:"Every tracked regression service was marked as skipped for this release"});
  } else {
    if(regFail.length){
      factors.conditional.push("regFail");
      risks.push({tone:"warn", text:"Regression failed: "+regFail.map(function(m){return esc(regressionItemLabel(m));}).join(", ")});
    }
    if(regWarn.length){
      factors.conditional.push("regWarn");
      risks.push({tone:"warn", text:"Regression warning: "+regWarn.map(function(m){return esc(regressionItemLabel(m));}).join(", ")});
    }
    if(regNotTested.length){
      factors.conditional.push("regNotTested");
      risks.push({tone:"neutral", text: regNotTested.length+" service"+pluralize(regNotTested.length,"","s")+" not yet regression tested"});
    }
  }

  // ---- 4. Blocked tickets ----
  if(blockedTickets.length){
    factors.conditional.push("blockedTickets");
    risks.push({tone:"warn", text: blockedTickets.length+" ticket"+pluralize(blockedTickets.length,"","s")+" in the release "+(blockedTickets.length===1?"is":"are")+" blocked"});
  }

  // ---- 5. Platform failures ----
  if(platFail.length){
    factors.conditional.push("platFail");
    risks.push({tone:"warn", text:"Platform failing: "+platFail.map(function(p){return p.label;}).join(", ")});
  }
  if(platWarn.length){
    factors.conditional.push("platWarn");
    risks.push({tone:"neutral", text:"Platform warning: "+platWarn.map(function(p){return p.label;}).join(", ")});
  }

  // ---- 6. Other warnings (performance, security) ----
  if(perfFail){
    factors.nogo.push("perfFail");
    risks.push({tone:"danger", text:"Performance testing failed its SLA/threshold"});
  } else if(perfWarn){
    factors.conditional.push("perfWarn");
    risks.push({tone:"warn", text:"Performance testing shows warnings against its SLA/threshold"});
  }
  if(secCriticalOpen || secFailStatus){
    factors.nogo.push("secCritical");
    if(secCriticalOpen) risks.push({tone:"danger", text: num(r.security.critical)+" critical security finding"+pluralize(num(r.security.critical),"","s")+" open"});
    else risks.push({tone:"danger", text:"Security testing status is FAIL"});
  } else if(secHighOpen){
    factors.conditional.push("secHigh");
    risks.push({tone:"warn", text: num(r.security.high)+" high-severity security finding"+pluralize(num(r.security.high),"","s")+" open"});
  }

  var recommendation;
  if(!hasAnyData){
    recommendation = "CONDITIONAL GO";
  } else if(factors.nogo.length){
    recommendation = "NO-GO";
  } else if(factors.conditional.length){
    recommendation = "CONDITIONAL GO";
  } else {
    recommendation = "GO";
  }

  var summary = buildSummary(r, recommendation, factors, {
    blockersOpen:blockersOpen, blockersProgress:blockersProgress, bugsCriticalOpen:bugsCriticalOpen,
    bugsHighOpen:bugsHighOpen, incCriticalActive:incCriticalActive, incHighActive:incHighActive,
    regFail:regFail, regWarn:regWarn, regNotTested:regNotTested,
    regSkipped:regSkipped, regItemsCount:regItems.length,
    blockedTickets:blockedTickets, platFail:platFail, platWarn:platWarn, hasAnyData:hasAnyData
  });

  return {recommendation:recommendation, summary:summary, risks:risks};
}

function releaseLabel(r){
  var n = r.name || "This release";
  var v = r.version ? " "+r.version : "";
  return n+v;
}

function buildSummary(r, recommendation, factors, d){
  var label = releaseLabel(r);
  if(!d.hasAnyData){
    return label+" has no QA information entered yet. Add regression results, known bugs and release blockers so an accurate readiness recommendation can be generated.";
  }
  var phrase = recommendation==="GO" ? "ready for release" :
               recommendation==="NO-GO" ? "not ready for release" : "conditionally ready for release";
  var sentences = [];

  if(d.blockersOpen.length){
    sentences.push("There "+(d.blockersOpen.length===1?"is an unresolved release blocker":"are "+d.blockersOpen.length+" unresolved release blockers")+" ("+d.blockersOpen.map(function(b){return b.title||"Untitled";}).slice(0,2).join(", ")+") that must be resolved before shipping.");
  } else if(d.blockersProgress.length){
    sentences.push(d.blockersProgress.length+" release blocker"+pluralize(d.blockersProgress.length,"","s")+" "+(d.blockersProgress.length===1?"is":"are")+" still in progress.");
  }
  if(factors.nogo.indexOf("bugsCritical")>-1){
    sentences.push(d.bugsCriticalOpen.length+" critical bug"+pluralize(d.bugsCriticalOpen.length,"","s")+" remain"+(d.bugsCriticalOpen.length===1?"s":"")+" open.");
  }
  if(d.bugsHighOpen.length){
    sentences.push(d.bugsHighOpen.length+" high-severity known bug"+pluralize(d.bugsHighOpen.length,"","s")+" remain"+(d.bugsHighOpen.length===1?"s":"")+" open.");
  }
  if(d.incCriticalActive.length){
    sentences.push(d.incCriticalActive.length+" critical incident"+pluralize(d.incCriticalActive.length,"","s")+" remain"+(d.incCriticalActive.length===1?"s":"")+" unresolved.");
  } else if(d.incHighActive.length){
    sentences.push(d.incHighActive.length+" high-severity incident"+pluralize(d.incHighActive.length,"","s")+" remain"+(d.incHighActive.length===1?"s":"")+" unresolved.");
  }
  if(d.regSkipped){
    // Marked not required — no narrative sentence needed, already surfaced as a risk line.
  } else if(!d.regItemsCount){
    sentences.push("Regression testing has not been started for this release.");
  } else if(d.regFail.length){
    sentences.push("Regression testing failed for "+d.regFail.map(function(m){return regressionItemLabel(m);}).join(", ")+".");
  } else if(d.regWarn.length){
    sentences.push("Regression testing returned warnings for "+d.regWarn.map(function(m){return regressionItemLabel(m);}).join(", ")+".");
  }
  if(d.blockedTickets.length && sentences.length<3){
    sentences.push(d.blockedTickets.length+" ticket"+pluralize(d.blockedTickets.length,"","s")+" in the release "+(d.blockedTickets.length===1?"is":"are")+" currently blocked.");
  }
  if(!d.regSkipped && d.regItemsCount && d.regNotTested.length && sentences.length<3){
    sentences.push(d.regNotTested.length+" service"+pluralize(d.regNotTested.length,"","s")+" "+(d.regNotTested.length===1?"has":"have")+" not been regression tested yet.");
  }
  if(d.platFail.length && sentences.length<3){
    sentences.push(d.platFail.map(function(p){return p.label;}).join(", ")+" "+(d.platFail.length===1?"is":"are")+" currently failing platform testing.");
  }
  if(!sentences.length && recommendation==="GO"){
    sentences.push("Regression, known bugs, tickets, platforms and blockers all look clear based on the information entered.");
  }
  if(!sentences.length){
    sentences.push("No blocking issues were found in the information entered, but coverage is still limited.");
  }
  sentences = sentences.slice(0,3);
  return label+" is "+phrase+". "+sentences.join(" ");
}

// Regression is stored as Entity -> Services (e.g. "CSPD" containing
// "Passport services", "Digital Certificates", ...). regressionEntities()
// normalizes a release's regression data into that shape, also tolerating
// older flat module rows (from before Entities/Services existed): a flat
// row is wrapped as a single-service "entity" that points back at the
// original object, so editing it still writes through to the real data
// instead of a disconnected copy.
function regressionEntities(r){
  return (r.regression||[]).map(function(item){
    if(item && Array.isArray(item.services)) return item;
    return {
      id: item.id,
      name: item.name,
      assignedTo: item.assignedTo || null,
      legacyOwner: item.legacyOwner,
      services: [{ id:item.id, name:item.name, status:item.status, notes:item.notes, lastChange:item.lastChange }],
      _legacy: item
    };
  });
}
function regressionAllServices(r){
  var out = [];
  regressionEntities(r).forEach(function(entity){
    var services = entity.services||[];
    if(!services.length){
      // No services under this entity (e.g. a page that isn't broken into
      // sub-services) — the entity's own status, set via the "Overall
      // status" control, stands in for it so it still counts toward the
      // release's regression totals/overall status instead of silently
      // being left out. Defaults to NOT TESTED, same as a freshly-synced
      // service, so an entity nobody has looked at yet still reads as
      // outstanding rather than as passing by omission.
      out.push({ entityId:entity.id, entityName:entity.name, id:entity.id, name:entity.name, status:entity.status||"NOT TESTED", notes:entity.notes, _entityLevel:true });
      return;
    }
    services.forEach(function(s){
      out.push({ entityId:entity.id, entityName:entity.name, id:s.id, name:s.name, status:s.status, notes:s.notes });
    });
  });
  return out;
}
function regressionItemLabel(m){
  if(m._entityLevel) return m.entityName || m.name || "Unnamed entity";
  return (m.entityName? m.entityName+" – ":"")+(m.name||"Unnamed service");
}
function regressionOverallStatus(r){
  // SKIP is a deliberate per-service exclusion — it should never read as
  // "in progress" or force a false PASS, so it's left out of the overall
  // read entirely (an all-SKIP release reads as NOT PROVIDED, same as empty).
  var items = regressionAllServices(r).filter(function(m){return m.status!=="SKIP";});
  if(!items.length) return "NOT PROVIDED";
  if(items.some(function(m){return m.status==="FAIL";})) return "FAIL";
  if(items.some(function(m){return m.status==="WARNING";})) return "WARNING";
  if(items.some(function(m){return m.status==="NOT TESTED";})) return "IN PROGRESS";
  return "PASS";
}
function regressionOverallTone(s){
  if(s==="FAIL") return "danger";
  if(s==="WARNING") return "warn";
  if(s==="IN PROGRESS") return "info";
  if(s==="NOT PROVIDED") return "neutral";
  return "go";
}
function regressionStatusEmoji(s){
  if(s==="FAIL") return "🔴";
  if(s==="WARNING") return "🟡";
  if(s==="PASS") return "🟢";
  if(s==="SKIP") return "⏭";
  return "⚪"; // NOT TESTED / IN PROGRESS / NOT PROVIDED
}
// Shared by regressionCounts (whole release) and regressionEntityCounts (one
// entity) below — same five buckets either way, just a different slice of
// services going in.
function regressionCountByStatus(items){
  return {
    total: items.length,
    passed: items.filter(function(m){return m.status==="PASS";}).length,
    warn: items.filter(function(m){return m.status==="WARNING";}).length,
    fail: items.filter(function(m){return m.status==="FAIL";}).length,
    notTested: items.filter(function(m){return m.status==="NOT TESTED";}).length,
    skipped: items.filter(function(m){return m.status==="SKIP";}).length
  };
}
function regressionCounts(r){
  return regressionCountByStatus(regressionAllServices(r));
}
function regressionStatLine(r){
  var c = regressionCounts(r);
  if(!c.total) return "No regression modules configured yet.";
  var parts = [c.passed+" / "+c.total+" passed"];
  if(c.warn) parts.push(c.warn+" warning"+pluralize(c.warn,"","s"));
  if(c.fail) parts.push(c.fail+" failed");
  if(c.notTested) parts.push(c.notTested+" not tested");
  if(c.skipped) parts.push(c.skipped+" skipped");
  return parts.join(" · ");
}
// One entity's own module count + status breakdown, for its compact
// summary line under the heading ("3 modules · 0 passed · 2 not tested").
function regressionEntityCounts(entity){
  return regressionCountByStatus((entity && entity.services) || []);
}
function regressionEntitySummaryLine(entity){
  var c = regressionEntityCounts(entity);
  if(!c.total) return "No services configured for this entity.";
  var parts = [c.total+" module"+pluralize(c.total,"","s"), c.passed+" passed"];
  if(c.notTested) parts.push(c.notTested+" not tested");
  if(c.warn) parts.push(c.warn+" warning"+pluralize(c.warn,"","s"));
  if(c.fail) parts.push(c.fail+" failed");
  if(c.skipped) parts.push(c.skipped+" skipped");
  return parts.join(" · ");
}

/* ---- Regression assignment: Know the Team member ids, per release ----
   Two levels, stored on the release's own regression data (so one release's
   assignments never touch another's):
     entity.assignedTo   member id | null — who covers the whole Entity
     service.assignedTo  OPTIONAL per-module override: key absent = "use the
                         Entity owner"; an id = that member; null =
                         deliberately unassigned even though the Entity has an
                         owner.
   Precedence is module > entity > nobody, so changing the Entity owner moves
   every module that follows it and never overwrites an explicit module-level
   choice. An entity with no services is tracked as one item and uses
   entity.assignedTo alone. Ids only — a display name is never an identity. */
// Members offered in a regression assignment list — the Know the Team roster
// narrowed to those with "Available for regression assignment" on.
// `m.regression !== false` (rather than `=== true`) so a member saved before
// that toggle existed, with no `regression` key at all, still counts as
// eligible instead of silently vanishing from every assign list.
function regressionOwnerOptions(){
  return allTeamMembers().filter(function(m){ return m.regression!==false && !!m.name; });
}
function regressionModuleHasOverride(service){
  return !!(service && Object.prototype.hasOwnProperty.call(service, "assignedTo"));
}
// Effective assignee of one module (service) of an entity: its own override
// when it has one, otherwise the Entity's owner. "" = nobody.
function regressionModuleAssigneeId(entity, service){
  if(regressionModuleHasOverride(service)) return service.assignedTo || "";
  return (entity && entity.assignedTo) || "";
}
// True when this member id is the person currently working (the team member
// the signed-in user linked themselves to) — the basis for "My Regression".
function regressionOwnerIsMe(memberId){
  var me = currentMemberId();
  return !!me && !!memberId && memberId===me;
}
// Narrows a list of entities (as regressionEntities() returns them) down to
// what a view should show, at the MODULE level (a module can carry its own
// assignee): "Mine" keeps the modules assigned to me, "Unassigned" the ones
// nobody covers. An entity whose modules only partly match is shown as a
// copy holding just the matching modules. Every action handler re-looks-up
// its target from the unfiltered release data by id anyway, so this is purely
// a display-time narrowing and never affects what gets saved.
function filterRegressionEntitiesForView(entities, view){
  if(view!=="Mine" && view!=="Unassigned") return entities;
  function matches(id){ return view==="Mine" ? regressionOwnerIsMe(id) : !id; }
  var out = [];
  entities.forEach(function(entity){
    var services = entity.services||[];
    if(!services.length){
      if(matches(entity.assignedTo||"")) out.push(entity);
      return;
    }
    var kept = services.filter(function(s){ return matches(regressionModuleAssigneeId(entity, s)); });
    if(kept.length===services.length) out.push(entity);
    else if(kept.length) out.push(Object.assign({}, entity, {services:kept}));
  });
  return out;
}
// A small "who changed this" note under a module whose status was last
// changed by someone other than the person it's assigned to. Compact on
// purpose (a collapsed one-line <details>), informational only — the change
// itself was never blocked. Shown only while the status still equals the
// change it describes, so it doesn't linger after the status moves on.
function regressionChangeNoteHtml(holder, currentStatus){
  if(!canViewStatistics()) return ""; // only people with Statistics access see who changed what
  var c = holder && holder.lastChange;
  if(!c || !c.byOther || c.newStatus!==(currentStatus||"NOT TESTED")) return "";
  var assignee = memberNameById(c.assignedTo);
  var by = c.changedBy ? memberNameById(c.changedBy) : (c.changedByName || "someone not on the team list");
  return '<details class="reg-change-note"><summary>⚠ Status changed by '+esc(by)+'</summary>'+
    '<div>This regression is assigned to <b>'+esc(assignee)+'</b>, but the status was changed by <b>'+esc(by)+'</b> ('+esc(c.previousStatus||"")+' → '+esc(c.newStatus||"")+(c.at?', '+esc(fmtDateTime(c.at)):'')+').</div></details>';
}
// Shown right after a status change is saved when the person who made it
// isn't the one it's assigned to. A heads-up only: the change already went
// through, and nothing here asks for confirmation.
function warnIfChangedByOther(assigneeId){
  if(!canViewStatistics()) return; // same audience as the change note: people with Statistics access
  if(!assigneeId || assigneeId===currentMemberId()) return;
  var who = (currentMember() && currentMember().name) || currentPreparerName() || "someone else";
  showToast("⚠ Regression status changed by another QA member — assigned to "+memberNameById(assigneeId)+", changed by "+who+".");
}

/* ============================================================
   RELEASE NOTES GENERATION — Jira-based
   Turns each ticket's own content (title, description, resolution, recent
   comments — whatever Jira actually gave us) into one short, plain-English
   line, categorized as a New Feature / Improvement / Bug Fix / Other. This
   is a local, rule-based summarizer (the same "AI-style, never invents"
   approach already used for the GO/NO-GO assessment above) — it condenses
   and rephrases only what's already in the ticket, it never calls out to an
   external AI/LLM service, and nothing about a ticket ever leaves this
   machine except to Jira itself. See README for the trade-off if you'd
   rather wire in a real LLM here.
   ============================================================ */
var TICKET_BUGFIX_RE = /\b(fix(?:e[sd])?|bug|crash(?:e[sd])?|error|defect|broken|fails?|failure)\b/i;
var TICKET_FEATURE_RE = /\b(add(?:s|ed)?|new|introduc(?:e|es|ed)|support(?:s|ed)? for|enable[sd]?|allow[sd]?)\b/i;
var TICKET_IMPROVEMENT_RE = /\b(improv(?:e|ed|es|ement)|updat(?:e|ed|es)|enhanc(?:e|ed|es|ement)|optimiz(?:e|ed|es)|refactor(?:ed|s)?)\b/i;
// Lines that are almost always ticket scaffolding rather than a description
// of the change itself — acceptance-criteria/step lists, not prose.
var BOILERPLATE_LINE_RE = /^(given|when|then|and)\b|^(ac|acceptance criteria|steps to reproduce|expected result|actual result)\s*[:\-]|^\d+[.)]\s|^[-*•]\s/i;

function categorizeTicket(t){
  var type = String(t.issueType||"").toLowerCase();
  if(type.indexOf("bug")>-1) return "Bug Fix";
  if(type.indexOf("story")>-1 || type.indexOf("feature")>-1 || type.indexOf("epic")>-1) return "New Feature";
  if(type.indexOf("improvement")>-1 || type.indexOf("enhancement")>-1) return "Improvement";
  // Generic issue types (Task, etc.) — fall back to reading the ticket's own
  // content, since it's often a better signal than a catch-all issue type.
  var text = [t.title, t.description].filter(Boolean).join(" ");
  if(TICKET_BUGFIX_RE.test(text)) return "Bug Fix";
  if(TICKET_FEATURE_RE.test(text)) return "New Feature";
  if(TICKET_IMPROVEMENT_RE.test(text)) return "Improvement";
  return "Other";
}
function stripBoilerplateLines(text){
  return String(text||"").split(/\n+/).map(function(l){return l.trim();})
    .filter(function(l){ return l && !BOILERPLATE_LINE_RE.test(l); })
    .join(" ");
}
function firstSentences(text, maxSentences, maxChars){
  var cleaned = stripBoilerplateLines(text).replace(/\s+/g," ").trim();
  if(!cleaned) return "";
  var parts = cleaned.match(/[^.!?]+[.!?]+/g) || [cleaned];
  var out = parts.slice(0, maxSentences).join(" ").trim();
  if(out.length > maxChars) out = out.slice(0, maxChars).replace(/\s+\S*$/,"")+"…";
  return out;
}
function ticketFallbackSentence(t, category){
  var subject = (t.title||t.key||"this ticket").replace(/^\s*the\s+/i,"");
  if(category==="Bug Fix") return "Fixed an issue with "+subject+".";
  if(category==="New Feature") return "Added "+subject+".";
  if(category==="Improvement") return "Improvement to "+subject+".";
  return "Update to "+subject+".";
}
// One short, human sentence per ticket — never copies the raw Jira
// description verbatim, never invents functionality that isn't there. Falls
// back to a neutral, still-honest line when there isn't enough to go on.
function summarizeTicket(t){
  var category = categorizeTicket(t);
  var source = t.description || t.recentComments || "";
  var sentence = firstSentences(source, 2, 220);
  if(!sentence || sentence.length < 12) sentence = ticketFallbackSentence(t, category);
  return {category:category, sentence:sentence};
}
function jiraKeyHtml(t){
  return t.url ? '<a href="'+escAttr(t.url)+'" target="_blank" rel="noopener">'+esc(t.key)+'</a>' : esc(t.key);
}

// Recommendation (GO / CONDITIONAL GO / NO-GO, from computeAssessment) is
// the app's own readiness signal — this maps it onto the company template's
// QA Status / QA Approval vocabulary (Approved / Approved with Known
// Issues / Not Approved) rather than tracking a second, separate value.
function qaStatusLabel(recommendation){
  if(recommendation==="GO") return "Approved";
  if(recommendation==="NO-GO") return "Not Approved";
  return "Approved with Known Issues"; // CONDITIONAL GO
}
// regressionOverallStatus(r) returns PASS/FAIL/WARNING/IN PROGRESS/NOT
// PROVIDED — this reads that onto the template's QA Validation wording
// without collapsing WARNING into a flat Passed/Failed (that would either
// overstate or understate what regression actually found).
function regressionTemplateLabel(status){
  if(status==="PASS") return "Passed";
  if(status==="FAIL") return "Failed";
  if(status==="WARNING") return "Passed with Warnings";
  if(status==="IN PROGRESS") return "In Progress";
  return "N/A"; // NOT PROVIDED
}
/* ---- Who am I? (identity = a Know the Team member id) ----
   Atlassian sign-in proves WHO the person is; Know the Team says which QA
   team member that is. A signed-in user pins "this entry is me" once (the
   team-card menu, the "Link to team" button in the top bar, or the one-click
   suggestion on an empty "My Regression") and that link is stored
   server-side on the member's own record (member.linkedEmail — see
   server/routes/team.js PUT /:id/link-me), so it works from any browser.
   Everything that needs "me" — My Regression, the changed-by-someone-else
   warning, assignments — compares TEAM MEMBER IDS, never display names. */
function myLinkedTeamMemberId(){
  var email = state.auth && state.auth.user && state.auth.user.email;
  if(!email) return "";
  email = String(email).trim().toLowerCase();
  var found = allTeamMembers().find(function(m){
    return m.linkedEmail && String(m.linkedEmail).trim().toLowerCase()===email;
  });
  return found ? found.id : "";
}
function currentMemberId(){ return myLinkedTeamMemberId(); }
function currentMember(){
  var id = myLinkedTeamMemberId();
  return id && state.team ? (state.team[id] || null) : null;
}
// A team member's display name from their id. An id with no matching member
// (someone since removed from Know the Team) reads as such instead of
// breaking, and an empty id reads as Unassigned.
function memberNameById(id){
  if(!id) return "Unassigned";
  var m = state.team && state.team[id];
  return m && m.name ? m.name : "Removed member";
}
// Same pill-radio look as statusChoiceGroup, but each choice carries a team
// member's ID as its value (the label is just the name) — so what gets saved
// is an id, never a name. `extras` are optional leading/trailing non-member
// choices: [{value, label}], e.g. Unassigned or "Use Entity owner".
function memberChoiceGroup(name, members, currentId, extras){
  var items = (extras||[]).filter(function(x){return !x.after;}).concat(members.map(function(m){ return {value:m.id, label:m.name}; }))
    .concat((extras||[]).filter(function(x){return x.after;}));
  return '<div class="status-choice">'+items.map(function(o, i){
    var id = name+"-"+i;
    return '<input type="radio" name="'+name+'" id="'+id+'" value="'+escAttr(o.value)+'" '+(o.value===currentId?"checked":"")+'><label for="'+id+'">'+esc(o.label)+'</label>';
  }).join("")+'</div>';
}
// Persists (or clears) the "This is me" link via the server, then reloads
// the roster — the server clears the link from whichever other entry held it
// before, and re-reading is the simplest way to stay exactly in sync — and
// re-renders. Used by the Know the Team card menu, the top-bar "Link to
// team" picker, and the one-click suggestion in the Regression section.
function setMyLinkedTeamMember(id, linked){
  return api.linkMeToTeamMember(id, linked).then(function(){
    return loadTeam();
  }).then(function(){
    renderTopbarUser();
    render();
  }).catch(function(err){
    showToast((err && err.message) || "Couldn't update that link.");
  });
}
function currentPreparerName(){
  var me = currentMember();
  if(me && me.name) return me.name;
  if(state.auth && state.auth.authenticated && state.auth.user && state.auth.user.name) return state.auth.user.name;
  return "";
}
// Normalizes a name for a *suggestion-only* fuzzy match — never used for the
// actual "is this me" comparison, which always stays an exact string match
// against the linked Know the Team entry (myLinkedTeamMemberId/
// regressionOwnerIsMe). Stripping punctuation/case/extra whitespace is
// exactly enough to see past what actually broke "My Regression" here (a
// stray apostrophe) without silently treating two different real people as
// the same one — it only ever powers a suggestion the user still has to
// click to confirm.
function normalizeNameForSuggestion(name){
  return String(name||"")
    .toLowerCase()
    .replace(/['’`´]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
// When the signed-in user hasn't linked themselves to a Know the Team entry
// yet, looks for one whose name normalizes to the same thing as their own
// (Atlassian) display name — e.g. "Sara Abu-Rumman" vs. "Sara' Abu-Rumman" —
// so the empty "My Regression" state can offer a one-click "is this you?"
// instead of sending them off to Know the Team to find and link it by hand.
// Returns null when already linked, or when nothing normalizes to a match.
function suggestedMyTeamMember(){
  if(myLinkedTeamMemberId()) return null;
  var mine = normalizeNameForSuggestion(currentPreparerName());
  if(!mine) return null;
  return allTeamMembers().find(function(m){ return normalizeNameForSuggestion(m.name)===mine; }) || null;
}
// One release-note item's fields, preferring the server-generated item
// (AI-assisted or rule-based, per releaseNotesLogic.js) and falling back to
// the same local rule-based summarizer used before that existed.
function noteItemFields(t, itemsByKey){
  var item = itemsByKey[t.key];
  if(item) return {t:t, category:item.category, title:item.title || (t.title||t.key), description:item.description};
  var s = summarizeTicket(t);
  return {t:t, category:s.category, title:t.title||t.key, description:s.sentence};
}
function noteFeatureBlockHtml(x){
  return "<h3>"+esc(x.title)+"</h3><p>"+esc(x.description)+"</p><p><strong>Jira:</strong> "+jiraKeyHtml(x.t)+"</p><hr>";
}

function generateReleaseNotesHtml(r){
  var tickets = r.tickets || [];
  // If Release Notes have been generated server-side (see handleGenerateNotes
  // — AI-assisted when configured, rule-based fallback otherwise, per
  // releaseNotesLogic.js), each ticket already has a category+title+summary
  // recorded in r.releaseNotes.items; use those instead of recomputing
  // locally. A ticket with no matching item (e.g. added after the last
  // generation, or an older release from before this existed) still falls
  // back to the original local rule-based summarizeTicket(t) — nothing about
  // that path changed.
  var itemsByKey = {};
  ((r.releaseNotes && r.releaseNotes.items) || []).forEach(function(it){ if(it.sourceKey) itemsByKey[it.sourceKey] = it; });
  var summarized = tickets.map(function(t){ return noteItemFields(t, itemsByKey); });
  var featureTickets = summarized.filter(function(x){return x.category==="New Feature";});
  var improvementTickets = summarized.filter(function(x){return x.category==="Improvement" || x.category==="Other";});
  var bugTickets = summarized.filter(function(x){return x.category==="Bug Fix";});

  var assessment = computeAssessment(r);
  var qaLabel = qaStatusLabel(assessment.recommendation);
  var preparer = currentPreparerName();

  // ---- Release Information ----
  var releaseInfoHtml =
    "<table><thead><tr><th>Field</th><th>Details</th></tr></thead><tbody>"+
    "<tr><td>Product / Application</td><td>"+(r.name? esc(r.name) : "[Product Name]")+"</td></tr>"+
    "<tr><td>Release Version</td><td>"+(r.version? esc(r.version) : "[Fix Version]")+"</td></tr>"+
    "<tr><td>Release Date</td><td>"+esc(fmtDate(r.date))+"</td></tr>"+
    "<tr><td>Environment</td><td>[Production / UAT / Staging]</td></tr>"+
    "<tr><td>Prepared By</td><td>"+(preparer? esc(preparer) : "[Name]")+"</td></tr>"+
    "<tr><td>QA Status</td><td>"+esc(qaLabel)+"</td></tr>"+
    "</tbody></table>";

  // ---- 1. Release Overview ----
  var releaseSummaryHtml = "<p>"+esc(assessment.summary)+"</p>";
  var highlightLines = (r.highlights||"").split("\n").map(function(s){return s.trim();}).filter(Boolean);
  var scopeItems = highlightLines.map(function(l){return "<li>"+esc(l)+"</li>";})
    .concat(featureTickets.map(function(x){return "<li>"+esc(x.title)+"</li>";}))
    .concat(improvementTickets.map(function(x){return "<li>"+esc(x.title)+"</li>";}));
  if(bugTickets.length) scopeItems.push("<li>"+bugTickets.length+" bug fix"+pluralize(bugTickets.length,"","es")+" (see Bug Fixes)</li>");
  var releaseScopeHtml = scopeItems.length
    ? "<p>This release includes:</p><ul>"+scopeItems.join("")+"</ul>"
    : "<p>No release scope has been recorded for this release yet.</p>";

  // ---- 2. New Features ----
  var newFeaturesHtml = featureTickets.length
    ? featureTickets.map(noteFeatureBlockHtml).join("")
    : "<p>No new features included in this release.</p>";

  // ---- 3. Enhancements & Improvements ----
  var enhancementsHtml = improvementTickets.length
    ? improvementTickets.map(noteFeatureBlockHtml).join("")
    : "<p>No enhancements or improvements included in this release.</p>";

  // ---- 4. Bug Fixes — Jira bug-fix tickets plus resolved manually-tracked bugs ----
  var resolvedBugs = (r.bugs||[]).filter(function(b){return b.status==="Resolved";});
  var bugFixRows = bugTickets.map(function(x){
    return "<tr><td>"+jiraKeyHtml(x.t)+"</td><td>"+esc(x.description)+"</td><td>"+esc(x.t.priority||"Not provided")+"</td></tr>";
  }).concat(resolvedBugs.map(function(b){
    return "<tr><td>"+esc(b.bugId||"—")+"</td><td>"+esc(b.title||"Untitled")+"</td><td>"+esc(b.severity||"Not provided")+"</td></tr>";
  }));
  var bugFixesHtml = bugFixRows.length
    ? "<table><thead><tr><th>Jira</th><th>Description</th><th>Impact</th></tr></thead><tbody>"+bugFixRows.join("")+"</tbody></table>"
    : "<p>No bug fixes included in this release.</p>";

  // ---- Incidents — only when the release has any. Rendered from the
  // snapshot taken when the notes were generated (r.releaseNotes.incidentItems,
  // see routes/releases.js), NOT from live r.incidents, so adding or editing
  // an incident never rewrites notes that already exist — only Generate
  // Release Notes refreshes it. Ticket-level lines lead with the ticket
  // reference; release-level ones are labeled "Release-level". The section is
  // inserted after Bug Fixes, so every later heading shifts down by one — but
  // only when it's present, leaving the numbering of a release with no
  // incidents exactly as it was.
  var incidentItems = (r.releaseNotes && r.releaseNotes.incidentItems) || [];
  var secOff = incidentItems.length ? 1 : 0;
  var incidentsSectionHtml = incidentItems.length
    ? "<h2>5. Incidents</h2><ul>"+incidentItems.map(function(it){
        var label = it.scope==="TICKET" && it.ticketKey
          ? it.ticketKey+(it.ticketTitle? " — "+it.ticketTitle : "")
          : "Release-level";
        return "<li><strong>"+esc(label)+":</strong> "+esc(it.summary)+"</li>";
      }).join("")+"</ul><hr>"
    : "";

  // ---- 5. Known Issues — open/deferred Known Bugs, plus flagged platform and regression results ----
  var openIssues = (r.bugs||[]).filter(function(b){return b.status==="Open" || b.status==="Deferred";});
  var platformIssues = ["web","android","ios"].filter(function(k){return r.platforms[k].status==="FAIL" || r.platforms[k].status==="WARNING";})
    .map(function(k){return {label:PLATFORM_LABELS[k]+" platform issue", impact:(r.platforms[k].notes||r.platforms[k].status)};});
  var regFlagged = regressionAllServices(r).filter(function(m){return m.status==="FAIL" || m.status==="WARNING";})
    .map(function(m){return {label:regressionItemLabel(m)+" regression", impact:m.status+(m.notes? " — "+m.notes:"")};});
  var knownRows = openIssues.map(function(b){
    return "<tr><td>"+esc(b.bugId||"—")+"</td><td>"+esc(b.title||"Untitled")+"</td><td>"+esc((b.severity||"Not provided")+", "+(b.status||""))+"</td></tr>";
  }).concat(platformIssues.map(function(x){
    return "<tr><td>—</td><td>"+esc(x.label)+"</td><td>"+esc(x.impact)+"</td></tr>";
  })).concat(regFlagged.map(function(x){
    return "<tr><td>—</td><td>"+esc(x.label)+"</td><td>"+esc(x.impact)+"</td></tr>";
  }));
  var knownIssuesHtml = knownRows.length
    ? "<table><thead><tr><th>Jira</th><th>Issue</th><th>Impact / Workaround</th></tr></thead><tbody>"+knownRows.join("")+"</tbody></table>"
    : "<p><strong>No known issues identified for this release.</strong></p>";

  // ---- 6. QA Validation ----
  var criticalOpen = (r.bugs||[]).filter(function(b){return b.severity==="Critical" && b.status==="Open";}).length;
  var highOpen = (r.bugs||[]).filter(function(b){return b.severity==="High" && b.status==="Open";}).length;
  var qaValidationHtml =
    "<table><thead><tr><th>Validation Area</th><th>Status</th></tr></thead><tbody>"+
    "<tr><td>Functional Testing</td><td>[Passed / Failed]</td></tr>"+
    "<tr><td>Regression Testing</td><td>"+esc(regressionTemplateLabel(regressionOverallStatus(r)))+"</td></tr>"+
    "<tr><td>Integration Testing</td><td>[Passed / Failed / N/A]</td></tr>"+
    "<tr><td>UAT</td><td>[Passed / Failed / N/A]</td></tr>"+
    "<tr><td>Critical Issues</td><td>"+criticalOpen+"</td></tr>"+
    "<tr><td>High Issues</td><td>"+highOpen+"</td></tr>"+
    "<tr><td>QA Approval</td><td>"+esc(qaLabel)+"</td></tr>"+
    "</tbody></table>";
  var qaNotesHtml = assessment.risks.length
    ? "<ul>"+assessment.risks.slice(0,8).map(function(x){return "<li>"+x.text+"</li>";}).join("")+"</ul>"
    : "<p>No additional QA notes, risks, or limitations recorded for this release.</p>";

  // ---- 7. Deployment Notes — not tracked by this app ----
  var deploymentRequirementsHtml = "<p>[Required configuration, migration, dependency, or deployment information.]</p>";
  var postDeploymentValidationHtml = "<p>[Checks that should be performed after deployment.]</p>";

  // ---- 8. Important Notes — not tracked by this app ----
  var importantNotesHtml = "<p>[Any additional information relevant to users, support teams, product teams, or deployment teams.]</p>";

  // ---- Release Approval — only the QA row has a real tracked equivalent (QA Owner + this assessment) ----
  var approvedDate = r.published && r.published.at ? esc(fmtDate(r.published.at)) : "[Date]";
  var approvalHtml =
    "<table><thead><tr><th>Role</th><th>Name</th><th>Status</th><th>Date</th></tr></thead><tbody>"+
    "<tr><td>QA</td><td>"+(r.qaOwner? esc(r.qaOwner) : "[Name]")+"</td><td>"+esc(qaLabel)+"</td><td>"+approvedDate+"</td></tr>"+
    "<tr><td>Product</td><td>[Name]</td><td>[Approved]</td><td>[Date]</td></tr>"+
    "<tr><td>Release Owner</td><td>[Name]</td><td>[Approved]</td><td>[Date]</td></tr>"+
    "</tbody></table>";

  return "<h1>RELEASE NOTES</h1>"+
    "<h2>Release Information</h2>"+releaseInfoHtml+
    "<hr>"+
    "<h2>1. Release Overview</h2>"+
    "<h3>Release Summary</h3>"+releaseSummaryHtml+
    "<h3>Release Scope</h3>"+releaseScopeHtml+
    "<hr>"+
    "<h2>2. New Features</h2>"+newFeaturesHtml+
    "<hr>"+
    "<h2>3. Enhancements &amp; Improvements</h2>"+enhancementsHtml+
    "<hr>"+
    "<h2>4. Bug Fixes</h2>"+bugFixesHtml+
    "<hr>"+
    incidentsSectionHtml+
    "<h2>"+(5+secOff)+". Known Issues</h2>"+knownIssuesHtml+
    "<hr>"+
    "<h2>"+(6+secOff)+". QA Validation</h2>"+qaValidationHtml+
    "<h3>QA Notes</h3>"+qaNotesHtml+
    "<hr>"+
    "<h2>"+(7+secOff)+". Deployment Notes</h2>"+
    "<h3>Deployment Requirements</h3>"+deploymentRequirementsHtml+
    "<h3>Post-Deployment Validation</h3>"+postDeploymentValidationHtml+
    "<hr>"+
    "<h2>"+(8+secOff)+". Important Notes</h2>"+importantNotesHtml+
    "<hr>"+
    "<h2>Release Approval</h2>"+approvalHtml;
}

/* ============================================================
   ROUTER
   ============================================================ */
function parseHash(){
  var h = location.hash.replace(/^#\/?/, "");
  // "#/" (or no hash) is now the landing page — the releases list lives at
  // the explicit "#/releases" route instead of owning the root.
  if(!h) return {view:"home"};
  if(h==="releases") return {view:"list"};
  if(h==="audit") return {view:"audit"};
  if(h==="statistics") return {view:"statistics"};
  if(h==="test-data") return {view:"testData"};
  if(h==="team") return {view:"team"};
  var m = h.match(/^r\/([^\/]+)$/);
  if(m) return {view:"detail", id:m[1]};
  return {view:"home"};
}
window.addEventListener("hashchange", function(){
  state.route = parseHash();
  boot();
});
function goTo(hash){ location.hash = hash; }

/* ============================================================
   DATA LOADING
   ============================================================ */
function loadList(){
  return api.listReleases().then(function(list){
    state.releases = {};
    state.releaseOrder = [];
    list.forEach(function(r){ state.releases[r._id] = r; state.releaseOrder.push(r._id); });
    state.listReady = true;
    state.loadError = null;
  }).catch(function(e){
    state.loadError = e.message;
  });
}
function loadOne(id){
  return api.getRelease(id).then(function(r){
    state.releases[id] = r;
    state.loadError = null;
  }).catch(function(e){
    state.loadError = e.message;
  });
}
function loadJiraStatus(){
  return api.jiraStatus().then(function(s){ state.jiraStatus = s; }).catch(function(){ state.jiraStatus = {connected:false}; });
}
function loadAuditLog(){
  return api.listAudit().then(function(list){
    state.auditLog = list;
    state.auditReady = true;
    state.loadError = null;
  }).catch(function(e){
    state.loadError = e.message;
  });
}
function loadTestData(){
  return api.listTestData().then(function(list){
    state.testData = {};
    state.testDataOrder = [];
    list.forEach(function(t){ state.testData[t.id] = t; state.testDataOrder.push(t.id); });
    state.testDataReady = true;
    state.loadError = null;
  }).catch(function(e){
    state.loadError = e.message;
  });
}

function loadTeam(){
  return api.listTeam().then(function(list){
    state.team = {};
    state.teamOrder = [];
    list.forEach(function(m){ state.team[m.id] = m; state.teamOrder.push(m.id); });
    state.teamReady = true;
    state.loadError = null;
  }).catch(function(e){
    state.loadError = e.message;
  });
}

function boot(){
  // Know the Team names are needed well beyond the Know the Team view
  // itself — regression/ticket assignment dropdowns (regressionOwnerOptions,
  // ticketAssigneeOptions) and "My Regression" (currentPreparerName) all
  // read state.team, so it has to be loaded on every boot rather than only
  // when navigating to "team" — otherwise a release opened directly (or on
  // first load) sees an empty roster until the user happens to visit Know
  // the Team first. Small dataset, cheap GET — same as loadJiraStatus above.
  var tasks = [loadJiraStatus(), loadTeam()];
  if(state.route.view==="detail"){
    tasks.push(loadOne(state.route.id));
  } else if(state.route.view==="audit"){
    tasks.push(loadAuditLog());
  } else if(state.route.view==="statistics"){
    // Statistics reads every release plus the audit log — read-only GETs, so
    // simply viewing it never writes an audit event.
    tasks.push(loadList());
    tasks.push(loadAuditLog());
  } else if(state.route.view==="testData"){
    tasks.push(loadTestData());
  } else if(state.route.view==="home"){
    // Landing page needs real release data (At a Glance / Recent Releases)
    // and the audit log (Recent Activity) — both read-only GETs, so simply
    // viewing the landing page never writes a new audit event.
    tasks.push(loadList());
    tasks.push(loadAuditLog());
  } else if(state.route.view!=="team"){
    // "team" needs nothing beyond the loadTeam() already queued above.
    tasks.push(loadList());
  }
  Promise.all(tasks).then(render);
}

/* ============================================================
   RENDER: SHELL
   ============================================================ */
function render(){
  var app = qs("#app");
  renderSidenav();
  renderTopbarUser();
  if(state.loadError){
    app.innerHTML = '<div class="empty-state"><h3>Can’t reach the server</h3><p>'+esc(state.loadError)+'</p><p class="helper-text" style="margin-top:8px;">Make sure the Greenlight server is running.</p></div>';
    return;
  }
  if(state.route.view==="detail"){
    var r = state.releases[state.route.id];
    if(!r){
      app.innerHTML = '<div class="empty-state"><h3>Loading release…</h3><div style="margin-top:16px;"><button class="btn" data-action="nav-list">Back to releases</button></div></div>';
      return;
    }
    app.innerHTML = renderDetail(r);
    afterDetailRender(r);
  } else if(state.route.view==="audit"){
    app.innerHTML = renderAuditLog();
  } else if(state.route.view==="statistics"){
    app.innerHTML = renderStatistics();
  } else if(state.route.view==="testData"){
    app.innerHTML = renderTestData();
  } else if(state.route.view==="team"){
    app.innerHTML = renderTeam();
  } else if(state.route.view==="home"){
    app.innerHTML = renderHome();
  } else {
    app.innerHTML = renderList();
  }
}

/* ============================================================
   RENDER: LIST
   ============================================================ */
/* ============================================================
   SIDE NAVIGATION
   Persistent left sidebar (desktop) / drawer (mobile) — the 4 sections
   the spec calls out. Re-rendered on every render() so the active item
   always matches state.route.view; the containing element itself lives
   in index.html and never gets replaced, so a mobile "open" class on
   .app-body survives across renders.
   ============================================================ */
var SIDENAV_ITEMS = [
  {icon:"🏠", label:"Landing Page", action:"nav-home", match:["home"]},
  {icon:"🚀", label:"Release Monitor", action:"nav-list", match:["list","detail"]},
  {icon:"🧪", label:"Test Data", action:"nav-test-data", match:["testData"]},
  {icon:"📊", label:"Statistics", action:"nav-statistics", match:["statistics"], needs:"statistics"},
  {icon:"📋", label:"Audit", action:"nav-audit", match:["audit"]},
  {icon:"👥", label:"Know the Team", action:"nav-team", match:["team"]}
];
// Statistics is limited to the Know the Team members flagged "Statistics
// access" — an opt-in flag (absent/false = no access) on the member the
// signed-in user linked themselves to. This gates the UI (nav item, landing
// card, the page itself); see README for what it does and doesn't protect.
function canViewStatistics(){
  var me = currentMember();
  return !!(me && me.statisticsAccess===true);
}
function sidenavHtml(){
  return SIDENAV_ITEMS.filter(function(it){ return it.needs!=="statistics" || canViewStatistics(); }).map(function(it){
    var active = it.match.indexOf(state.route.view) > -1;
    return '<button type="button" class="sidenav-item'+(active?" active":"")+'" data-action="'+it.action+'">'+
      '<span class="sidenav-icon">'+it.icon+'</span><span class="sidenav-label">'+esc(it.label)+'</span></button>';
  }).join("");
}
function renderSidenav(){
  var el = qs("#sidenav");
  if(el) el.innerHTML = sidenavHtml();
}

/* ============================================================
   RENDER: HOME / LANDING PAGE
   The default page on entry (#/). Purely a jumping-off point — it reads
   the same release/audit data as the Releases and Audit pages (no
   duplicate data structures, no invented metrics) and never writes
   anything itself.
   ============================================================ */
function computeHomeStats(){
  // The data model has no archive/close concept — every release still in
  // the store is being tracked, so "Active Releases" is simply the count
  // of releases that exist. GO/NO-GO counts reuse computeAssessment(), the
  // same engine the release list and detail pages already use.
  var ids = state.releaseOrder || [];
  var openBlockers = 0, goCount = 0, nogoCount = 0;
  ids.forEach(function(id){
    var r = state.releases[id];
    if(!r) return;
    openBlockers += (r.blockers||[]).filter(function(b){return b.status==="Open";}).length;
    var a = computeAssessment(r);
    if(a.recommendation==="GO") goCount++;
    else if(a.recommendation==="NO-GO") nogoCount++;
  });
  return {activeReleases: ids.length, openBlockers: openBlockers, goCount: goCount, nogoCount: nogoCount};
}
function recentReleasesHtml(){
  var ids = state.releaseOrder || [];
  if(!ids.length){
    return '<div class="empty-state" style="padding:32px 24px;"><h3>No releases yet</h3><p>Create your first release to start tracking QA readiness.</p></div>';
  }
  var sorted = ids.map(function(id){return state.releases[id];}).filter(Boolean).sort(function(a,b){
    return String(b.updatedAt||b.createdAt||"").localeCompare(String(a.updatedAt||a.createdAt||""));
  }).slice(0,5);
  var rows = sorted.map(function(r){
    var a = computeAssessment(r);
    var tone = toneForStatus(a.recommendation);
    return '<div class="recent-row" data-action="nav-detail" data-id="'+esc(r._id)+'" tabindex="0" role="button">'+
      '<div class="recent-row-name">'+esc(r.name||"Untitled release")+' <span class="ver mono">'+esc(r.version||"")+'</span></div>'+
      pill(a.recommendation, tone)+
      '<div class="recent-row-updated helper-text">'+esc(fmtRelativeTime(r.updatedAt||r.createdAt))+'</div>'+
    '</div>';
  }).join("");
  return '<div class="card recent-list">'+rows+'</div>';
}
function recentActivityHtml(){
  // Only ever reads the audit log already loaded for the Audit page —
  // never logs anything of its own. Resolves a release name only when the
  // entry is directly about a release (entityType "Release") and that
  // release is currently loaded; otherwise falls back to the same details
  // text the full Audit Log page shows, rather than guessing.
  var entries = (state.auditLog||[]).slice(0,5);
  if(!entries.length) return "";
  var rows = entries.map(function(e){
    var releaseName = (e.entityType==="Release" && state.releases[e.entityId]) ? releaseLabel(state.releases[e.entityId]) : "";
    var detail = releaseName || e.details || "";
    return '<div class="audit-row recent-activity-row">'+
      '<div class="audit-row-user">'+iconUser()+' '+esc(auditActorName(e))+'</div>'+
      '<div class="audit-row-body"><span class="audit-row-action">'+esc(humanizeAuditAction(e.action))+'</span>'+
        (detail ? ' <span class="audit-row-details">— '+esc(detail)+'</span>' : '')+
      '</div>'+
      '<div class="audit-row-time helper-text">'+esc(fmtRelativeTime(e.createdAt))+'</div>'+
    '</div>';
  }).join("");
  return '<div class="card audit-list">'+rows+'</div>';
}
function renderHome(){
  if(!state.listReady){
    return '<div class="empty-state"><h3>Loading your workspace…</h3></div>';
  }
  var stats = computeHomeStats();

  var hero =
    '<section class="hero">'+
      '<h1>Your QA workspace</h1>'+
      '<p class="hero-sub">Everything you need to prepare, validate, and support your releases — in one place.</p>'+
      '<div class="hero-flow">Collect → Assess → Decide → Communicate</div>'+
    '</section>';

  var cards = [
    {icon:"🚀", title:"Release Monitor", desc:"Monitor release readiness from one place.", btn:"Open Releases →", action:"nav-list"},
    {icon:"🧪", title:"Test Data", desc:"Manage reusable QA test data, scenarios, entities and tags.", btn:"Open Test Data →", action:"nav-test-data"},
    {icon:"📊", title:"Statistics", desc:"See QA workload and activity by date, release and team member.", btn:"Open Statistics →", action:"nav-statistics"},
    {icon:"📋", title:"Audit", desc:"Track important changes and see who performed them.", btn:"View Audit →", action:"nav-audit"},
    {icon:"👥", title:"Know the Team", desc:"Meet the people behind the quality.", btn:"Meet the Team →", action:"nav-team"}
  ].filter(function(c){ return c.action!=="nav-statistics" || canViewStatistics(); });
  var cardsHtml = '<section class="home-section"><div class="feature-grid">'+
    cards.map(function(c){
      return '<div class="feature-card">'+
        '<div class="feature-card-icon">'+c.icon+'</div>'+
        '<h3>'+esc(c.title)+'</h3>'+
        '<p>'+esc(c.desc)+'</p>'+
        '<button type="button" class="btn feature-card-btn" data-action="'+c.action+'">'+esc(c.btn)+'</button>'+
      '</div>';
    }).join("")+
  '</div></section>';

  var glance = '<section class="home-section">'+
    '<div class="home-section-head"><h2>At a Glance</h2></div>'+
    '<div class="ticket-stats home-stats">'+
      statTile(stats.activeReleases, "Active Releases")+
      statTile(stats.openBlockers, "Open Blockers")+
      statTile(stats.goCount, "Releases with GO")+
      statTile(stats.nogoCount, "Releases with NO-GO")+
    '</div>'+
  '</section>';

  var recent = '<section class="home-section">'+
    '<div class="home-section-head"><h2>Recent Releases</h2>'+
      '<span class="home-view-all" data-action="nav-list">View all releases →</span>'+
    '</div>'+
    recentReleasesHtml()+
  '</section>';

  var activityBody = recentActivityHtml();
  var activity = activityBody ? (
    '<section class="home-section">'+
      '<div class="home-section-head"><h2>Recent Activity</h2>'+
        '<span class="home-view-all" data-action="nav-audit">View Audit →</span>'+
      '</div>'+
      activityBody+
    '</section>'
  ) : "";

  var teamIntro = '<section class="home-section home-team-intro">'+
    '<div class="card home-team-card">'+
      '<div><h3>Know the Team</h3><p class="helper-text">Meet the people behind the quality.</p></div>'+
      '<button type="button" class="btn" data-action="nav-team">Meet the Team →</button>'+
    '</div>'+
  '</section>';

  return hero + cardsHtml + glance + recent + activity + teamIntro;
}

function renderList(){
  var ids = state.releaseOrder;
  var head = '<div class="list-head"><div><h1>Releases</h1><p>Track QA readiness across every release your team is shipping.</p></div>'+
    '<button class="btn btn-primary" data-action="create-release">'+iconPlus()+' New release</button></div>'+
    renderSearchBar();

  if(!state.listReady) return head + '<div class="empty-state"><h3>Loading releases…</h3></div>';
  if(!ids.length){
    return head + '<div class="empty-state"><h3>No releases yet</h3><p>Create your first release to start tracking QA readiness.</p>'+
      '<div style="margin-top:16px;"><button class="btn btn-primary" data-action="create-release">'+iconPlus()+' New release</button></div></div>';
  }

  var cards = ids.map(function(id){
    var r = state.releases[id];
    if(!r) return "";
    var a = computeAssessment(r);
    var tone = toneForStatus(a.recommendation);
    var summary = ticketSummary(r);
    var total = Math.max(summary.total,1);
    var segs = [
      {v:summary.completed, color:"var(--go-fg)"},
      {v:summary.inQA, color:"var(--accent)"},
      {v:summary.blocked, color:"var(--danger-fg)"}
    ];
    var bar = segs.map(function(s){ return '<span style="width:'+ (s.v/total*100) +'%;background:'+s.color+';"></span>'; }).join("");
    var published = r.published && r.published.at;
    return '<div class="release-card" data-action="nav-detail" data-id="'+id+'" tabindex="0" role="button">'+
      '<div class="release-card-top">'+
        '<div><h3>'+esc(r.name||"Untitled release")+'</h3><div class="ver mono">'+esc(r.version||"No version")+'</div></div>'+
        '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">'+pill(a.recommendation, tone)+(published?pill("🚀 Published","go"):"")+'</div>'+
      '</div>'+
      '<div class="release-meta-row">'+
        '<span>'+iconCalendar()+' <b>'+esc(fmtDate(r.date))+'</b></span>'+
        '<span>'+iconUser()+' <b>'+esc(r.qaOwner||"Not provided")+'</b></span>'+
      '</div>'+
      '<div>'+
        '<div class="mini-bar">'+bar+'</div>'+
        '<div class="release-meta-row" style="margin-top:6px;">'+summary.completed+' / '+summary.total+' tickets complete'+(summary.blocked?' &middot; '+summary.blocked+' blocked':'')+'</div>'+
      '</div>'+
    '</div>';
  }).join("");

  return head+'<div class="release-grid">'+cards+'</div>';
}

/* ============================================================
   RENDER: AUDIT LOG
   A simple, read-only, newest-first activity feed — who did what, and
   when. Not tied to any one release; it's a record across all of them.
   ============================================================ */
var AUDIT_ACTION_LABELS = {
  RELEASE_CREATED: "Created Release",
  RELEASE_UPDATED: "Updated Release Info",
  TICKET_ADDED: "Added Ticket",
  TICKET_UPDATED: "Updated Ticket",
  TICKET_ASSIGNED: "Assigned Ticket",
  TICKET_REASSIGNED: "Reassigned Ticket",
  TICKET_UNASSIGNED: "Unassigned Ticket",
  TICKET_QA_ASSIGNED: "Assigned Ticket QA Owner", // older, name-based records
  TICKET_QA_UNASSIGNED: "Unassigned Ticket QA Owner", // older, name-based records
  JIRA_SYNCED: "Synced Jira",
  REGRESSION_UPDATED: "Updated Regression",
  REGRESSION_ASSIGNED: "Assigned Regression",
  REGRESSION_UNASSIGNED: "Unassigned Regression",
  ENTITY_REGRESSION_ASSIGNED: "Assigned Entity Regression",
  KNOWN_BUG_ADDED: "Added Known Bug",
  KNOWN_BUG_UPDATED: "Updated Known Bug",
  BLOCKER_ADDED: "Added Blocker",
  BLOCKER_UPDATED: "Updated Blocker",
  INCIDENT_CREATED: "Added Incident",
  INCIDENT_UPDATED: "Updated Incident",
  INCIDENT_DELETED: "Deleted Incident",
  PLATFORM_UPDATED: "Updated Platform",
  PERFORMANCE_UPDATED: "Updated Performance",
  SECURITY_UPDATED: "Updated Security",
  AI_ASSESSMENT_GENERATED: "Generated AI Assessment",
  RELEASE_NOTES_GENERATED: "Generated Release Notes",
  RELEASE_NOTES_UPDATED: "Updated Release Notes",
  MOBILE_RELEASE_NOTE_UPDATED: "Updated Mobile Release Note",
  TEST_DATA_CREATED: "Added Test Data",
  TEST_DATA_IMPORTED: "Imported Test Data",
  TEST_DATA_UPDATED: "Updated Test Data",
  TEST_DATA_COPIED: "Copied Test Data",
  TEST_DATA_DELETED: "Deleted Test Data",
  TEAM_MEMBER_ADDED: "Added Team Member",
  TEAM_MEMBER_UPDATED: "Updated Team Member",
  TEAM_MEMBER_DELETED: "Deleted Team Member"
};
function humanizeAuditAction(action){
  return AUDIT_ACTION_LABELS[action] || action;
}
// Who an audit record is attributed to: the Know the Team member it carries
// (looked up by stable id, so a renamed member reads under their current
// name), falling back to the name recorded with the entry — which is how
// older records, and activity by someone not yet linked to a team member,
// still read sensibly.
function auditActorName(e){
  var m = e && e.teamMemberId && state.team ? state.team[e.teamMemberId] : null;
  return (m && m.name) || (e && e.userName) || "Unknown";
}
// The compact extra block for a regression status change made by someone
// other than the assignee ("⚠ Saraa changed regression status — Assigned to /
// Changed by / PREVIOUS → NEW"). Quiet by design: one muted block under the
// row, only for the changes that actually warrant it.
function auditStatusChangeWarnHtml(e){
  var m = e && e.meta;
  if(!canViewStatistics()) return ""; // same audience as the change note
  if(!m || !m.byOther || e.action!=="REGRESSION_UPDATED") return "";
  var by = m.changedBy ? memberNameById(m.changedBy) : auditActorName(e);
  return '<div class="audit-row-warn"><span class="audit-warn-head">⚠ '+esc(by)+' changed regression status</span><br>'+
    'Assigned to: '+esc(memberNameById(m.assignedTo))+' · Changed by: '+esc(by)+' · '+esc(m.previousStatus||"")+' → '+esc(m.newStatus||"")+'</div>';
}
function renderAuditLog(){
  var entries = state.auditLog || [];
  var head = '<div class="list-head"><div><h1>Audit Log</h1><p>Who did what, across every release — newest first.</p></div>'+
    '<button class="btn" data-action="nav-list">'+iconBack()+' Back to releases</button></div>';
  if(!state.auditReady) return head+'<div class="empty-state"><h3>Loading activity…</h3></div>';
  if(!entries.length){
    return head+'<div class="empty-state"><h3>No activity yet</h3><p>Actions like adding a ticket, updating regression results or generating release notes will show up here.</p></div>';
  }
  var rows = entries.map(function(e){
    return '<div class="audit-row">'+
      '<div class="audit-row-time mono">'+esc(fmtDateTime(e.createdAt)||"")+'</div>'+
      '<div class="audit-row-user">'+iconUser()+' '+esc(auditActorName(e))+'</div>'+
      '<div class="audit-row-body"><span class="audit-row-action">'+esc(humanizeAuditAction(e.action))+'</span>'+
        (e.details ? ' <span class="audit-row-details">— '+esc(e.details)+'</span>' : '')+
        auditStatusChangeWarnHtml(e)+
      '</div>'+
    '</div>';
  }).join("");
  return head+'<div class="card audit-list">'+rows+'</div>';
}

/* ============================================================
   STATISTICS
   A dedicated page (not part of the Release Monitor): simple workload and
   QA-activity tables, filterable by date, release and QA member — every
   member comes from Know the Team. Everything is computed from real data:
   release documents (tickets, ticket/regression assignments and statuses,
   blockers) for "what's assigned and where it stands", and Audit events
   carrying structured data (assignments, regression status changes) for
   "what happened when". Nothing is invented — an item with no date (e.g.
   assigned before this feature existed) only appears under "All time", and
   a filter that matches nothing says so.

   Definitions (the same everywhere on the page):
     Tickets Assigned     tickets whose QA owner is a team member
     Regression Assigned  regression modules whose effective owner is a member
     Completed Work       regression modules tested (PASS / FAIL / WARNING)
                          + tickets in the Completed bucket
     Passed / Failed      regression modules currently PASS / FAIL
     Blocked              tickets in the Blocked bucket + open release blockers
                          (release blockers belong to the release, not a member)
     Status Changes       regression status changes a member made
     Changed By Others    changes to a member's assigned regression made by
                          someone else (assignedTo != changedBy)
   This is workload visibility for the QA workflow — deliberately no ranking,
   scoring or comparison between people.
   ============================================================ */
var STATS_RANGES = [
  {value:"all", label:"All time"},
  {value:"7d", label:"Last 7 days"},
  {value:"30d", label:"Last 30 days"},
  {value:"custom", label:"Custom range"}
];
function statsDefaultFilters(){ return {range:"all", from:"", to:"", releaseId:"", memberId:""}; }
function statsStartOfDay(d){ var x = new Date(d); x.setHours(0,0,0,0); return x.getTime(); }
// {from, to} in ms; null = unbounded on that side. `now` is injectable for tests.
function statsRangeBounds(f, now){
  var n = now ? new Date(now) : new Date();
  if(f.range==="7d") return {from: statsStartOfDay(n.getTime()-6*86400000), to: n.getTime()};
  if(f.range==="30d") return {from: statsStartOfDay(n.getTime()-29*86400000), to: n.getTime()};
  if(f.range==="custom"){
    var from = f.from ? new Date(f.from+"T00:00:00").getTime() : null;
    var to = f.to ? new Date(f.to+"T23:59:59.999").getTime() : null;
    return {from: isNaN(from)?null:from, to: isNaN(to)?null:to};
  }
  return {from:null, to:null};
}
function statsInRange(ts, bounds, f){
  if(f.range==="all") return true;
  if(ts==null || isNaN(ts)) return false; // undated -> only under "All time"
  if(bounds.from!=null && ts<bounds.from) return false;
  if(bounds.to!=null && ts>bounds.to) return false;
  return true;
}
function statsTime(iso){ var t = iso ? new Date(iso).getTime() : NaN; return isNaN(t) ? null : t; }
function statsMaxTime(a, b){ return a==null ? b : (b==null ? a : Math.max(a,b)); }
// Every ticket / regression module / open blocker of one release as a flat
// item with its effective assignee, current status and (when known) the time
// of its latest dated activity.
function statsReleaseItems(r){
  var items = [];
  (r.tickets||[]).forEach(function(t){
    // A ticket with several QA owners is one item per owner (so each person's
    // row counts it); `ticketKey` lets the cards count the ticket only once.
    var ids = ticketAssignedMemberIds(t);
    (ids.length ? ids : [""]).forEach(function(id){
      items.push({kind:"ticket", releaseId:r._id, ticketKey:t.key, assignee:id, ts:statsTime(t.assignedAt),
        blocked:t.bucket==="Blocked", completed:t.bucket==="Completed"});
    });
  });
  regressionEntities(r).forEach(function(entity){
    var real = entity._legacy || entity;
    var services = entity.services||[];
    if(!services.length){
      items.push({kind:"regression", releaseId:r._id, assignee:entity.assignedTo||"", status:entity.status||"NOT TESTED",
        ts:statsMaxTime(statsTime(real.assignedAt), statsTime(real.lastChange && real.lastChange.at))});
      return;
    }
    services.forEach(function(sv){
      var override = regressionModuleHasOverride(sv) && !entity._legacy;
      var holder = entity._legacy ? entity._legacy : sv;
      var assignedAt = override ? statsTime(sv.assignedAt) : statsTime(real.assignedAt);
      items.push({kind:"regression", releaseId:r._id, assignee:regressionModuleAssigneeId(entity, sv), status:sv.status||"NOT TESTED",
        ts:statsMaxTime(assignedAt, statsTime(holder.lastChange && holder.lastChange.at))});
    });
  });
  (r.blockers||[]).forEach(function(b){
    if(b.status==="Open" || b.status==="In Progress") items.push({kind:"blocker", releaseId:r._id, assignee:"", ts:null});
  });
  return items;
}
// Statistics covers the QA team only: Know the Team members available for
// regression assignment (the same list the Regression section assigns from).
function statsQaIds(){
  var o = {};
  regressionOwnerOptions().forEach(function(m){ o[m.id] = true; });
  return o;
}
function statsEmptyRow(){ return {tickets:0, regression:0, passed:0, failed:0, notTested:0, skipped:0, blocked:0}; }
function statsAddItem(row, it){
  if(it.kind==="ticket"){ row.tickets++; if(it.blocked) row.blocked++; }
  else if(it.kind==="regression"){ row.regression++; if(it.status==="PASS") row.passed++; else if(it.status==="FAIL") row.failed++; else if(it.status==="NOT TESTED") row.notTested++; else if(it.status==="SKIP") row.skipped++; }
  else if(it.kind==="blocker"){ row.blocked++; }
}
// The whole page's numbers for a set of filters: {f:{range,from,to,releaseId,memberId}}.
function computeStatistics(f, now){
  f = Object.assign(statsDefaultFilters(), f||{});
  var bounds = statsRangeBounds(f, now);
  var relIds = (state.releaseOrder||[]).filter(function(id){ return state.releases[id] && (!f.releaseId || id===f.releaseId); });
  var qa = statsQaIds();

  // ---- snapshot items (assignments + where each stands) ----
  var items = [];
  relIds.forEach(function(id){
    statsReleaseItems(state.releases[id]).forEach(function(it){
      if(it.kind==="blocker") return; // release-level, belongs to no one
      if(!qa[it.assignee]) return; // unassigned, or not a QA team member
      if(!statsInRange(it.ts, bounds, f)) return;
      if(f.memberId && it.assignee!==f.memberId) return;
      items.push(it);
    });
  });
  var cards = {ticketsAssigned:0, regressionAssigned:0, completed:0, passed:0, failed:0, notTested:0, skipped:0, blocked:0};
  var byMember = {}; // assignee id ("" = nobody) -> row
  var byRelease = {};
  var seenTickets = {}; // a ticket with several QA owners counts once in the cards / release table
  items.forEach(function(it){
    var firstOfTicket = true;
    if(it.kind==="ticket"){
      var tk = it.releaseId+"\u0000"+it.ticketKey;
      firstOfTicket = !seenTickets[tk]; seenTickets[tk] = true;
      if(firstOfTicket){
        if(it.assignee) cards.ticketsAssigned++;
        if(it.completed) cards.completed++;
        if(it.blocked) cards.blocked++;
      }
    } else if(it.kind==="regression"){
      if(it.assignee) cards.regressionAssigned++;
      if(it.status==="PASS"||it.status==="FAIL"||it.status==="WARNING") cards.completed++;
      if(it.status==="PASS") cards.passed++;
      if(it.status==="FAIL") cards.failed++;
      if(it.status==="NOT TESTED") cards.notTested++;
      if(it.status==="SKIP") cards.skipped++;
    } else if(it.kind==="blocker"){
      cards.blocked++;
    }
    statsAddItem(byMember[it.assignee] = byMember[it.assignee] || statsEmptyRow(), it);
    if(firstOfTicket) statsAddItem(byRelease[it.releaseId] = byRelease[it.releaseId] || statsEmptyRow(), it);
  });

  // ---- audit events with structured data (who changed whose regression) ----
  // Each regression status change is credited to the person it is ASSIGNED
  // to: if they changed it themselves it's one of their "Status Changes";
  // if anyone else changed it (assignedTo != changedBy) it's one of their
  // "Changed By Others" — and is NOT counted as a status change of the
  // person who made it. A change to an unassigned module belongs to no one.
  var activity = {}; // member id -> {assigned, statusChanges, changedByOthers}
  var eventCount = 0;
  function actRow(id){ return activity[id] = activity[id] || {assigned:0, statusChanges:0, changedByOthers:0}; }
  (state.auditLog||[]).forEach(function(e){
    var m = e && e.meta;
    if(!m || e.action!=="REGRESSION_UPDATED" || !m.newStatus) return;
    if(f.releaseId && m.releaseId!==f.releaseId) return;
    if(!statsInRange(statsTime(e.createdAt), bounds, f)) return;
    var owner = typeof m.assignedTo==="string" ? m.assignedTo : "";
    if(!owner || !qa[owner]) return; // only QA team members' own regression
    if(f.memberId && owner!==f.memberId) return;
    eventCount++;
    if(m.changedBy===owner) actRow(owner).statusChanges++;
    else actRow(owner).changedByOthers++;
  });
  // "Assigned" in the assignment-vs-activity table = regression modules
  // currently assigned to the member (same items as above).
  items.forEach(function(it){ if(it.kind==="regression" && it.assignee) actRow(it.assignee).assigned++; });

  return {
    filters: f, cards: cards, byMember: byMember, byRelease: byRelease,
    activity: activity,
    hasData: items.length>0 || eventCount>0
  };
}
function statsRowIsEmpty(row){ return !row || (!row.tickets && !row.regression && !row.passed && !row.failed && !row.notTested && !row.skipped && !row.blocked); }
function statsMemberLabel(id){ return id ? memberNameById(id) : "Unassigned"; }
// Member ids that appear in a keyed map, ordered by display name with
// "Unassigned" last (alphabetical — never ordered by any number).
function statsOrderedIds(map){
  var ids = Object.keys(map);
  var real = ids.filter(function(id){return id!=="";}).sort(function(a,b){ return statsMemberLabel(a).localeCompare(statsMemberLabel(b)); });
  return ids.indexOf("")>-1 ? real.concat([""]) : real;
}
function statsTable(headers, rowsHtml){
  if(!rowsHtml) return '<div class="stats-empty">No data available for the selected filters.</div>';
  return '<div class="stats-table-wrap"><table class="stats-table"><thead><tr>'+headers.map(function(h,i){
    return '<th'+(i>0?' class="num"':'')+'>'+esc(h)+'</th>';
  }).join("")+'</tr></thead><tbody>'+rowsHtml+'</tbody></table></div>';
}
function statsNumCell(n){ return '<td class="num">'+n+'</td>'; }
function statsFiltersHtml(f){
  var releases = (state.releaseOrder||[]).map(function(id){ return state.releases[id]; }).filter(Boolean);
  var members = regressionOwnerOptions();
  return '<div class="stats-filters">'+
    '<div class="field"><label for="stats-range">Date</label><select id="stats-range" data-stats-field="range">'+
      STATS_RANGES.map(function(o){ return '<option value="'+o.value+'"'+(f.range===o.value?" selected":"")+'>'+esc(o.label)+'</option>'; }).join("")+'</select></div>'+
    (f.range==="custom" ? '<div class="field"><label for="stats-from">From</label><input type="date" id="stats-from" data-stats-field="from" value="'+escAttr(f.from)+'"></div>'+
      '<div class="field"><label for="stats-to">To</label><input type="date" id="stats-to" data-stats-field="to" value="'+escAttr(f.to)+'"></div>' : '')+
    '<div class="field"><label for="stats-release">Release</label><select id="stats-release" data-stats-field="releaseId"><option value="">All Releases</option>'+
      releases.map(function(r){ return '<option value="'+escAttr(r._id)+'"'+(f.releaseId===r._id?" selected":"")+'>'+esc(releaseLabel(r))+'</option>'; }).join("")+'</select></div>'+
    '<div class="field"><label for="stats-member">QA Member</label><select id="stats-member" data-stats-field="memberId"><option value="">All Members</option>'+
      members.map(function(m){ return '<option value="'+escAttr(m.id)+'"'+(f.memberId===m.id?" selected":"")+'>'+esc(m.name)+'</option>'; }).join("")+'</select></div>'+
  '</div>';
}
function renderStatisticsNoAccess(){
  var me = currentMember();
  var why = !me
    ? 'Link your sign-in to your <b>Know the Team</b> entry first (top bar → Link to team), then ask a teammate who has access to turn on <b>Statistics access</b> for you.'
    : 'Your Know the Team entry doesn’t have <b>Statistics access</b>. Ask a teammate who has it to turn it on in Know the Team → Edit.';
  return '<div class="list-head"><div><h1>Statistics</h1></div></div>'+
    '<div class="empty-state"><h3>You don’t have access to Statistics</h3><p>'+why+'</p></div>';
}
function renderStatistics(){
  if(!state.teamReady) return '<div class="list-head"><div><h1>Statistics</h1></div></div><div class="empty-state"><h3>Loading…</h3></div>';
  if(!canViewStatistics()) return renderStatisticsNoAccess();
  var head = '<div class="list-head"><div><h1>Statistics</h1><p>Workload and QA activity of the QA team across releases — for visibility only, not a performance measure.</p></div></div>';
  if(!state.listReady || !state.auditReady) return head+'<div class="empty-state"><h3>Loading statistics…</h3></div>';
  var f = state.statsFilters || (state.statsFilters = statsDefaultFilters());
  var st = computeStatistics(f);
  var filtersHtml = statsFiltersHtml(f);
  if(!st.hasData){
    return head+filtersHtml+'<div class="stats-empty">No data available for the selected filters.</div>';
  }
  var c = st.cards;
  function card(n, label){ return '<div class="stats-card"><div class="num">'+n+'</div><div class="label">'+esc(label)+'</div></div>'; }
  var cardsHtml = '<div class="stats-cards">'+
    card(c.ticketsAssigned,"Tickets Assigned")+card(c.regressionAssigned,"Regression Assigned")+card(c.completed,"Completed Work")+
    card(c.passed,"Passed Regression")+card(c.failed,"Failed Regression")+card(c.notTested,"Not Tested Regression")+card(c.skipped,"Skipped Regression")+card(c.blocked,"Blocked Items")+'</div>';

  var memberRows = statsOrderedIds(st.byMember).map(function(id){
    var r = st.byMember[id]; if(statsRowIsEmpty(r)) return "";
    return '<tr><td>'+esc(statsMemberLabel(id))+'</td>'+statsNumCell(r.tickets)+statsNumCell(r.regression)+statsNumCell(r.passed)+statsNumCell(r.failed)+statsNumCell(r.notTested)+statsNumCell(r.skipped)+statsNumCell(r.blocked)+'</tr>';
  }).join("");
  var releaseRows = (state.releaseOrder||[]).filter(function(id){ return st.byRelease[id] && !statsRowIsEmpty(st.byRelease[id]); }).map(function(id){
    var r = st.byRelease[id];
    return '<tr><td>'+esc(releaseLabel(state.releases[id]))+'</td>'+statsNumCell(r.tickets)+statsNumCell(r.regression)+statsNumCell(r.passed)+statsNumCell(r.failed)+statsNumCell(r.notTested)+statsNumCell(r.skipped)+statsNumCell(r.blocked)+'</tr>';
  }).join("");
  var actIds = statsOrderedIds(st.activity).filter(function(id){ return id!==""; });
  var actRows = actIds.map(function(id){
    var a = st.activity[id]; if(!a.assigned && !a.statusChanges && !a.changedByOthers) return "";
    return '<tr><td>'+esc(memberNameById(id))+'</td>'+statsNumCell(a.assigned)+statsNumCell(a.statusChanges)+statsNumCell(a.changedByOthers)+'</tr>';
  }).join("");

  return head+filtersHtml+cardsHtml+
    '<div class="stats-section"><h2>By QA member</h2>'+statsTable(["QA Member","Tickets","Regression","Passed","Failed","Not Tested","Skipped","Blocked"], memberRows)+'</div>'+
    '<div class="stats-section"><h2>By release</h2>'+statsTable(["Release","Tickets","Regression","Passed","Failed","Not Tested","Skipped","Blocked"], releaseRows)+'</div>'+
    '<div class="stats-section"><h2>Assignment vs. activity</h2>'+statsTable(["QA Member","Assigned","Status Changes","Changed By Others"], actRows)+
      '<p class="stats-note">Assigned = regression modules currently assigned · Status Changes = changes the member made to their own assigned regression · Changed By Others = changes to the member’s assigned regression made by someone else (counted for the assignee only, not as the other person’s status change). This is for QA workflow visibility only — not a measure of anyone’s performance.</p></div>'+
    '<p class="stats-note">Items assigned before assignment dates were recorded have no date, so they appear under “All time” only. Only QA team members (Know the Team members available for regression assignment) are included — unassigned work, other assignees and release-level blockers are not.</p>';
}

/* ============================================================
   KNOW THE TEAM
   An editable, informational team roster — independent of releases and
   independent of the auth system entirely: no login roles, no permissions,
   no permissions of their own. Adding or editing a member never
   grants them any access to the app; it's display data only, stored the
   same way Test Data is (its own top-level collection, plain REST CRUD).
   Starts from a small starter roster server-side (see server/db.js's
   buildDefaultTeam) — real people replace it as they're added.
   ============================================================ */
function initials(name){
  var parts = String(name||"").trim().split(/\s+/).filter(Boolean);
  if(!parts.length) return "?";
  var first = parts[0].charAt(0);
  var last = parts.length>1 ? parts[parts.length-1].charAt(0) : "";
  return (first+last).toUpperCase();
}
function allTeamMembers(){
  return state.teamOrder.map(function(id){ return state.team[id]; }).filter(Boolean);
}
var TEAM_UNASSIGNED_DEPARTMENT = "Unassigned";
function teamMemberCardHtml(m){
  var specialtiesHtml = (m.specialties||[]).map(function(s){return '<span class="chip">'+esc(s)+'</span>';}).join("");
  var toolsHtml = (m.tools||[]).map(function(t){return '<span class="chip chip-muted">'+esc(t)+'</span>';}).join("");
  var linkBits = [];
  if(m.linkedin) linkBits.push('<a class="btn btn-ghost btn-sm" href="'+escAttr(m.linkedin)+'" target="_blank" rel="noopener">'+iconLink()+' LinkedIn</a>');
  if(m.github) linkBits.push('<a class="btn btn-ghost btn-sm" href="'+escAttr(m.github)+'" target="_blank" rel="noopener">'+iconLink()+' GitHub</a>');
  var avatar = m.photo ? '<img src="'+escAttr(m.photo)+'" alt="">' : esc(initials(m.name));
  // Any signed-in user can pin "this entry is me" — that link is what ties
  // their assignments, audit trail and statistics to this team member.
  var showMeOption = !!(state.auth && state.auth.authenticated);
  var isMe = showMeOption && myLinkedTeamMemberId()===m.id;
  return '<div class="team-card">'+
    '<div class="dd team-card-menu">'+
      '<button class="btn btn-sm btn-icon" data-action="toggle-team-menu" data-id="'+m.id+'" aria-label="More actions">'+iconDots()+'</button>'+
      '<div class="menu" id="team-menu-'+m.id+'">'+
        (showMeOption ? '<button data-action="toggle-my-team-member" data-id="'+m.id+'">'+iconUser()+(isMe?' Remove "This is me"':' This is me')+'</button>' : '')+
        '<button data-action="edit-team-member" data-id="'+m.id+'">'+iconEdit()+' Edit</button>'+
        '<button class="danger" data-action="delete-team-member" data-id="'+m.id+'">'+iconTrash()+' Delete</button>'+
      '</div>'+
    '</div>'+
    '<div class="team-avatar'+(m.photo?" has-photo":"")+'">'+avatar+'</div>'+
    '<div class="team-card-name">'+esc(m.name)+(isMe?' <span class="badge badge-me" title="Regression assigned to you shows up in your My Regression view">'+iconUser()+' You</span>':'')+(m.seeded?' <span class="badge badge-manual">Example</span>':'')+'</div>'+
    '<div class="team-card-role">'+esc(m.role||"")+(m.regression===false?' <span class="hint">· not in Regression assign list</span>':'')+(m.statisticsAccess===true?' <span class="hint">· Statistics access</span>':'')+'</div>'+
    (m.bio ? '<p class="team-card-bio">'+esc(m.bio)+'</p>' : '')+
    (specialtiesHtml ? '<div class="team-card-chips">'+specialtiesHtml+'</div>' : '')+
    (toolsHtml ? '<div class="team-card-chips">'+toolsHtml+'</div>' : '')+
    (linkBits.length ? '<div class="team-card-links">'+linkBits.join("")+'</div>' : '')+
  '</div>';
}
// Groups members by their Department field (trimmed; blank → "Unassigned"),
// sorted alphabetically with Unassigned always last — so the roster reads
// as one flat grid until departments are actually in use, and gracefully
// buckets anyone who hasn't been assigned one yet rather than hiding them.
function groupTeamByDepartment(members){
  var byKey = {};
  var order = [];
  members.forEach(function(m){
    var label = (m.department||"").trim() || TEAM_UNASSIGNED_DEPARTMENT;
    var key = label.toLowerCase();
    if(!byKey[key]){ byKey[key] = {label:label, members:[]}; order.push(key); }
    byKey[key].members.push(m);
  });
  var groups = order.map(function(k){ return byKey[k]; });
  groups.sort(function(a,b){
    if(a.label===TEAM_UNASSIGNED_DEPARTMENT && b.label!==TEAM_UNASSIGNED_DEPARTMENT) return 1;
    if(b.label===TEAM_UNASSIGNED_DEPARTMENT && a.label!==TEAM_UNASSIGNED_DEPARTMENT) return -1;
    return a.label.localeCompare(b.label);
  });
  return groups;
}
function renderTeamGridHtml(){
  var all = allTeamMembers();
  if(!all.length){
    return '<div class="empty-state"><h3>No team members yet</h3><p>Add the people behind the quality.</p>'+
      '<div style="margin-top:16px;"><button class="btn btn-primary" data-action="add-team-member">'+iconPlus()+' Add Team Member</button></div></div>';
  }
  var groups = groupTeamByDepartment(all);
  // Skip the group headings entirely when everyone lands in one bucket —
  // no point labeling a single "Unassigned" or single-department group.
  if(groups.length<=1){
    return '<div class="team-grid">'+all.map(teamMemberCardHtml).join("")+'</div>';
  }
  return groups.map(function(g){
    return '<div class="team-group">'+
      '<div class="team-group-heading">'+esc(g.label)+' <span class="team-group-count">'+g.members.length+'</span></div>'+
      '<div class="team-grid">'+g.members.map(teamMemberCardHtml).join("")+'</div>'+
    '</div>';
  }).join("");
}
function renderTeam(){
  var head = '<div class="list-head"><div><h1>Know the Team</h1><p>Meet the people behind the quality — informational only.</p></div>'+
    '<button class="btn btn-primary" data-action="add-team-member">'+iconPlus()+' Add Team Member</button></div>';
  if(!state.teamReady) return head+'<div class="empty-state"><h3>Loading team…</h3></div>';
  return head + renderTeamGridHtml();
}

// Resizes/compresses a chosen photo client-side (center-cropped square,
// capped at 320px, JPEG ~0.85 quality) before it's ever sent to the server —
// keeps store.json small and avoids needing file-upload/multipart handling
// for what's just a small display photo. Resolves "" if the browser can't
// decode the file (falls back to the initials avatar rather than failing
// the whole save).
function readAndResizePhoto(file){
  return new Promise(function(resolve){
    if(!file || !/^image\//.test(file.type)){ resolve(""); return; }
    var reader = new FileReader();
    reader.onerror = function(){ resolve(""); };
    reader.onload = function(){
      var img = new Image();
      img.onerror = function(){ resolve(""); };
      img.onload = function(){
        var size = 320;
        var side = Math.min(img.width, img.height);
        var sx = (img.width-side)/2, sy = (img.height-side)/2;
        var canvas = document.createElement("canvas");
        canvas.width = size; canvas.height = size;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function openTeamMemberModal(existing){
  var isEdit = !!existing;
  var draft = existing
    // A record saved before the Regression toggle existed has no `regression`
    // key at all — treat that as eligible (checked) so nobody who was already
    // usable as a regression assignee silently disappears from the list.
    ? {name:existing.name, role:existing.role||"", department:existing.department||"", bio:existing.bio||"", specialties:(existing.specialties||[]).slice(), tools:(existing.tools||[]).slice(), linkedin:existing.linkedin||"", github:existing.github||"", photo:existing.photo||"", regression: existing.regression!==false, statisticsAccess: existing.statisticsAccess===true, jiraNames:(existing.jiraNames||[]).slice()}
    : {name:"", role:"", department:"", bio:"", specialties:[], tools:[], linkedin:"", github:"", photo:"", regression:true, statisticsAccess:false, jiraNames:[]};
  var pendingPhoto = draft.photo; // updated in place as the file input changes; submitted as-is
  var departmentOptions = distinct(allTeamMembers().map(function(m){return m.department;}));

  var title = isEdit ? "Edit Team Member" : "Add Team Member";
  var body =
    '<div class="field"><label>Photo <span class="hint">(optional)</span></label>'+
      '<div class="team-photo-field">'+
        '<div class="team-avatar team-photo-preview'+(draft.photo?" has-photo":"")+'" id="f-team-photo-preview">'+(draft.photo?'<img src="'+escAttr(draft.photo)+'" alt="">':esc(initials(draft.name)))+'</div>'+
        '<div><input type="file" id="f-team-photo" accept="image/png,image/jpeg,image/webp">'+
          (draft.photo? '<button type="button" class="btn btn-ghost btn-sm" id="f-team-photo-remove" style="margin-top:6px;">'+iconTrash()+' Remove photo</button>' : '')+
        '</div>'+
      '</div>'+
    '</div>'+
    '<div class="field"><label for="f-team-name">Name</label><input type="text" id="f-team-name" value="'+escAttr(draft.name)+'" required placeholder="e.g. Sara Abu Rumman"></div>'+
    '<div class="field-row">'+
      '<div class="field"><label for="f-team-role">Role <span class="hint">(optional)</span></label><input type="text" id="f-team-role" value="'+escAttr(draft.role)+'" placeholder="e.g. QA Team Lead"></div>'+
      '<div class="field"><label for="f-team-department">Department <span class="hint">(optional)</span></label><input type="text" id="f-team-department" list="team-department-suggestions" value="'+escAttr(draft.department)+'" placeholder="e.g. QA"></div>'+
    '</div>'+
    suggestionDatalist("team-department-suggestions", departmentOptions)+
    '<div class="field"><label for="f-team-bio">Short bio <span class="hint">(optional)</span></label><textarea id="f-team-bio" rows="3">'+esc(draft.bio)+'</textarea></div>'+
    '<div class="field"><label for="f-team-specialties">QA specialties <span class="hint">(optional)</span></label><input type="text" id="f-team-specialties" value="'+escAttr(draft.specialties.join(", "))+'" placeholder="e.g. Automation, QA Strategy"><span class="hint">Separate multiple with commas.</span></div>'+
    '<div class="field"><label for="f-team-jira-names">Jira name(s) <span class="hint">(optional)</span></label><input type="text" id="f-team-jira-names" value="'+escAttr(draft.jiraNames.join(", "))+'" placeholder="e.g. Sara\' Aburomman"><span class="hint">Only needed when Jira spells this person differently from the Name above — tickets Jira assigns under it then count for them. Separate multiple with commas.</span></div>'+
    '<div class="field"><label for="f-team-tools">Tools / technologies <span class="hint">(optional)</span></label><input type="text" id="f-team-tools" value="'+escAttr(draft.tools.join(", "))+'" placeholder="e.g. Playwright, Postman"><span class="hint">Separate multiple with commas.</span></div>'+
    '<div class="field-row">'+
      '<div class="field"><label for="f-team-linkedin">LinkedIn <span class="hint">(optional)</span></label><input type="url" id="f-team-linkedin" value="'+escAttr(draft.linkedin)+'" placeholder="https://linkedin.com/in/…"></div>'+
      '<div class="field"><label for="f-team-github">GitHub <span class="hint">(optional)</span></label><input type="url" id="f-team-github" value="'+escAttr(draft.github)+'" placeholder="https://github.com/…"></div>'+
    '</div>'+
    '<div class="field">'+
      '<span class="regression-skip-toggle">Available for regression assignment'+toggleSwitch("team-regression", draft.regression, "Show this person in the Regression section's assignment dropdowns")+'</span>'+
      '<span class="hint" style="display:block;margin-top:4px;">Off = hidden from the Regression section\'s assign lists (still visible here in Know the Team).</span>'+
    '</div>'+
    '<div class="field">'+
      '<span class="regression-skip-toggle">Statistics access'+toggleSwitch("team-statistics", draft.statisticsAccess, "Let this person open the Statistics page (once they link their sign-in to this card)")+'</span>'+
      '<span class="hint" style="display:block;margin-top:4px;">Off = the Statistics page is hidden for this person. Takes effect once they use “Link to team” / “This is me”.</span>'+
    '</div>';
  var foot = (isEdit? '<button type="button" class="btn btn-danger" id="del-team-member">'+iconTrash()+' Delete</button>' : '<span></span>')+
    '<span style="flex:1"></span><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">'+(isEdit?"Save changes":"Save")+'</button>';

  openModal(modalShell(title, body, foot));

  var photoInput = qs("#f-team-photo");
  if(photoInput) photoInput.addEventListener("change", function(){
    var file = photoInput.files && photoInput.files[0];
    if(!file) return;
    readAndResizePhoto(file).then(function(dataUrl){
      if(!dataUrl){ showToast("Couldn't read that image — try a different file."); return; }
      pendingPhoto = dataUrl;
      var preview = qs("#f-team-photo-preview");
      if(preview){ preview.innerHTML = '<img src="'+escAttr(dataUrl)+'" alt="">'; preview.classList.add("has-photo"); }
    });
  });
  var removePhotoBtn = qs("#f-team-photo-remove");
  if(removePhotoBtn) removePhotoBtn.addEventListener("click", function(){
    pendingPhoto = "";
    var preview = qs("#f-team-photo-preview");
    if(preview){ preview.innerHTML = esc(initials(qs("#f-team-name").value)); preview.classList.remove("has-photo"); }
  });

  var delBtn = qs("#del-team-member");
  if(delBtn) delBtn.addEventListener("click", function(){
    closeModal();
    openConfirm("Delete this team member?", "This removes <b>"+esc(existing.name)+"</b> from Know the Team.", "Delete", function(){ deleteTeamMember(existing.id); }, true);
  });

  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    var name = qs("#f-team-name").value.trim();
    if(!name){ qs("#f-team-name").focus(); return; }
    var payload = {
      name: name,
      role: qs("#f-team-role").value.trim(),
      department: qs("#f-team-department").value.trim(),
      bio: qs("#f-team-bio").value.trim(),
      specialties: splitCommaList(qs("#f-team-specialties").value),
      tools: splitCommaList(qs("#f-team-tools").value),
      jiraNames: splitCommaList(qs("#f-team-jira-names").value),
      linkedin: qs("#f-team-linkedin").value.trim(),
      github: qs("#f-team-github").value.trim(),
      photo: pendingPhoto,
      regression: !!(qs("#toggle-team-regression") && qs("#toggle-team-regression").checked),
      statisticsAccess: !!(qs("#toggle-team-statistics") && qs("#toggle-team-statistics").checked)
    };
    var submitBtn = qs('#modal-form button[type="submit"]');
    if(submitBtn) submitBtn.disabled = true;
    var req = isEdit ? api.updateTeamMember(existing.id, payload) : api.createTeamMember(payload);
    req.then(function(saved){
      state.team[saved.id] = saved;
      if(state.teamOrder.indexOf(saved.id)===-1) state.teamOrder.unshift(saved.id);
      closeModal();
      renderSidenav();
      if(state.route.view==="team") render();
      logAudit({action: isEdit ? "TEAM_MEMBER_UPDATED" : "TEAM_MEMBER_ADDED", entityType:"TeamMember", entityId:saved.id, details:saved.name});
      showToast(isEdit? "✓ Team member updated" : "✓ Team member added");
    }).catch(function(err){
      if(submitBtn) submitBtn.disabled = false;
      showToast(err.message || "Couldn't save team member.");
    });
  });
}
function deleteTeamMember(id){
  var m = state.team[id];
  api.deleteTeamMember(id).then(function(){
    delete state.team[id];
    state.teamOrder = state.teamOrder.filter(function(x){return x!==id;});
    if(state.route.view==="team") render();
    logAudit({action:"TEAM_MEMBER_DELETED", entityType:"TeamMember", entityId:id, details: m? m.name : id});
    showToast("Team member deleted");
  }).catch(function(e){ showToast("Couldn't delete: "+e.message); });
}

/* ============================================================
   TEST DATA
   A reusable QA data library — independent of any release. Records are
   keyed by National ID with free-text Supported Scenarios / Entity / Tags /
   Notes. Not a test-management system: no test cases, no executions, no
   relationship to releases. Follows the same render/modal/persist patterns
   used for releases (openModal/modalShell/openConfirm, logAudit, apiCall).
   ============================================================ */
// Seed suggestions for the Scenario/Entity datalists (from the spec's own
// examples) — merged at render time with whatever values are already in
// use, so the list grows with real data instead of staying fixed.
var TEST_DATA_SCENARIO_SUGGESTIONS = ["Female Head of Family","Divorced","Widow","Electronic Payment","Digital Family Book","Government Employee"];
var TEST_DATA_ENTITY_SUGGESTIONS = ["Family Book","Payments","Performance","Sessions","Services"];

function distinct(arr){
  var seen = {}; var out = [];
  (arr||[]).forEach(function(v){
    if(v==null || v==="") return;
    var k = String(v).toLowerCase();
    if(seen[k]) return;
    seen[k] = true;
    out.push(v);
  });
  return out;
}
// Splits a comma-separated field into a trimmed, de-duped (case-insensitive)
// list — same normalization the server applies, done client-side too so the
// preview in the form matches what actually gets saved.
function splitCommaList(value){
  var seen = {}; var out = [];
  String(value||"").split(",").forEach(function(raw){
    var v = raw.trim();
    if(!v) return;
    var k = v.toLowerCase();
    if(seen[k]) return;
    seen[k] = true;
    out.push(v);
  });
  return out;
}
function suggestionDatalist(id, options){
  return '<datalist id="'+id+'">'+options.map(function(o){return '<option value="'+escAttr(o)+'">';}).join("")+'</datalist>';
}
function allTestDataRecords(){
  return state.testDataOrder.map(function(id){ return state.testData[id]; }).filter(Boolean);
}
var TEST_DATA_PAGE_SIZE = 25;
function filterTestData(){
  var all = allTestDataRecords();
  var q = (state.testDataSearch||"").trim().toLowerCase();
  // Entity/Tags filters are searchable text inputs (with a datalist of
  // suggestions) rather than fixed dropdowns — an empty value means "no
  // filter", and any typed text matches as a substring, same as the main
  // search box, so picking a suggestion or just typing part of a name both
  // work.
  var entQ = (state.testDataEntityFilter||"").trim().toLowerCase();
  var tagQ = (state.testDataTagFilter||"").trim().toLowerCase();
  return all.filter(function(t){
    if(entQ && !(t.entities||[]).some(function(en){return en.toLowerCase().indexOf(entQ)>-1;})) return false;
    if(tagQ && !(t.tags||[]).some(function(tg){return tg.toLowerCase().indexOf(tagQ)>-1;})) return false;
    if(!q) return true;
    var hay = [t.nationalId, (t.supportedScenarios||[]).join(" "), (t.entities||[]).join(" "), (t.tags||[]).join(" "), t.notes]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.indexOf(q) > -1;
  });
}
function renderTestData(){
  var head = '<div class="list-head"><div><h1>Test Data</h1><p>Reusable test data for QA</p></div>'+
    '<div class="list-head-actions">'+
      '<button class="btn" data-action="import-test-data">'+iconUpload()+' Import</button>'+
      '<button class="btn btn-primary" data-action="add-test-data">'+iconPlus()+' Add Test Data</button>'+
    '</div></div>';

  if(!state.testDataReady) return head+'<div class="empty-state"><h3>Loading test data…</h3></div>';

  var all = allTestDataRecords();
  if(!all.length){
    return head+'<div class="empty-state"><h3>No test data yet</h3><p>Add reusable QA test data to quickly access it across your releases, or import a spreadsheet.</p>'+
      '<div style="margin-top:16px;display:flex;gap:8px;justify-content:center;">'+
        '<button class="btn" data-action="import-test-data">'+iconUpload()+' Import</button>'+
        '<button class="btn btn-primary" data-action="add-test-data">'+iconPlus()+' Add Test Data</button>'+
      '</div></div>';
  }

  var entityOptions = distinct(all.reduce(function(acc,t){return acc.concat(t.entities||[]);},[])).sort();
  var tagOptions = distinct(all.reduce(function(acc,t){return acc.concat(t.tags||[]);},[])).sort();
  var q = state.testDataSearch||"";

  // Once there's data, add an Export button — downloads the currently
  // searched/filtered view as an .xlsx (no search/filters active = full
  // export), so it stays in sync with whatever's on screen.
  head = '<div class="list-head"><div><h1>Test Data</h1><p>Reusable test data for QA</p></div>'+
    '<div class="list-head-actions">'+
      '<button class="btn" data-action="export-test-data">'+iconDownload()+' Export</button>'+
      '<button class="btn" data-action="import-test-data">'+iconUpload()+' Import</button>'+
      '<button class="btn btn-primary" data-action="add-test-data">'+iconPlus()+' Add Test Data</button>'+
    '</div></div>';

  var controls =
    '<div class="td-toolbar">'+
      '<div class="search-box td-search-box">'+iconSearch()+
        '<input type="text" id="td-search" autocomplete="off" placeholder="Search test data…" value="'+escAttr(q)+'">'+
        '<button type="button" class="search-clear" id="td-search-clear" data-action="clear-td-search" aria-label="Clear search"'+(q?'':' hidden')+'>'+iconClose()+'</button>'+
      '</div>'+
      '<div class="td-controls">'+
        '<label class="helper-text" for="td-entity-filter">Entities</label>'+
        '<input type="search" id="td-entity-filter" list="td-entity-filter-options" autocomplete="off" placeholder="All entities" value="'+escAttr(state.testDataEntityFilter||"")+'">'+
        '<datalist id="td-entity-filter-options">'+entityOptions.map(function(e){return '<option value="'+escAttr(e)+'">';}).join("")+'</datalist>'+
        '<label class="helper-text" for="td-tag-filter">Tags</label>'+
        '<input type="search" id="td-tag-filter" list="td-tag-filter-options" autocomplete="off" placeholder="All tags" value="'+escAttr(state.testDataTagFilter||"")+'">'+
        '<datalist id="td-tag-filter-options">'+tagOptions.map(function(tg){return '<option value="'+escAttr(tg)+'">';}).join("")+'</datalist>'+
      '</div>'+
    '</div>';

  var listHead =
    '<div class="td-list-head">'+
      '<div class="td-col td-col-id">National ID</div>'+
      '<div class="td-col td-col-scenarios">Supported Scenarios</div>'+
      '<div class="td-col td-col-entity">Entities</div>'+
      '<div class="td-col td-col-tags">Tags</div>'+
      '<div class="td-col td-col-notes">Notes</div>'+
      '<div class="td-col td-col-actions" style="width:32px;"></div>'+
    '</div>';
  return head+controls+listHead+'<div id="td-list-container">'+renderTestDataListHtml()+'</div>';
}
function renderTestDataListHtml(){
  var filtered = filterTestData();
  if(!filtered.length){
    state.testDataPage = 1;
    return '<div class="empty-state"><h3>No matches</h3><p>No test data matches your search or filters.</p></div>';
  }
  // Clamp the current page into range — filters/search reset it to 1
  // themselves, but this also covers a delete shrinking the last page.
  var totalPages = Math.max(1, Math.ceil(filtered.length / TEST_DATA_PAGE_SIZE));
  if(state.testDataPage > totalPages) state.testDataPage = totalPages;
  if(state.testDataPage < 1) state.testDataPage = 1;
  var page = state.testDataPage;
  var startIdx = (page-1)*TEST_DATA_PAGE_SIZE;
  var pageItems = filtered.slice(startIdx, startIdx+TEST_DATA_PAGE_SIZE);
  var q = state.testDataSearch||"";
  var pager =
    '<div class="td-pagination">'+
      '<span class="helper-text">Showing '+(startIdx+1)+'–'+(startIdx+pageItems.length)+' of '+filtered.length+'</span>'+
      '<div class="td-pagination-controls">'+
        '<button type="button" class="btn btn-sm" data-action="td-page-prev"'+(page<=1?' disabled':'')+'>← Prev</button>'+
        '<span class="helper-text td-pagination-status">Page '+page+' of '+totalPages+'</span>'+
        '<button type="button" class="btn btn-sm" data-action="td-page-next"'+(page>=totalPages?' disabled':'')+'>Next →</button>'+
      '</div>'+
    '</div>';
  return '<div class="td-list">'+pageItems.map(function(t){
    return '<div class="td-row">'+
      '<div class="td-col td-col-id"><span class="mono">'+highlightMatch(t.nationalId, q)+'</span></div>'+
      '<div class="td-col td-col-scenarios">'+(t.supportedScenarios||[]).map(function(s){return '<span class="chip">'+highlightMatch(s,q)+'</span>';}).join("")+'</div>'+
      '<div class="td-col td-col-entity">'+((t.entities&&t.entities.length)? t.entities.map(function(en){return '<span class="chip chip-muted">'+highlightMatch(en,q)+'</span>';}).join("") : '<span class="helper-text">—</span>')+'</div>'+
      '<div class="td-col td-col-tags">'+(t.tags||[]).map(function(tg){return '<span class="chip chip-muted">'+highlightMatch(tg,q)+'</span>';}).join("")+'</div>'+
      '<div class="td-col td-col-notes">'+(t.notes? '<span class="helper-text" title="'+escAttr(t.notes)+'">'+esc(t.notes.length>60?t.notes.slice(0,60)+"…":t.notes)+'</span>' : '')+'</div>'+
      '<div class="td-col td-col-actions">'+
        '<div class="dd">'+
          '<button class="btn btn-sm btn-icon" data-action="toggle-td-menu" data-id="'+t.id+'" aria-label="More actions">'+iconDots()+'</button>'+
          '<div class="menu" id="td-menu-'+t.id+'">'+
            '<button data-action="view-test-data" data-id="'+t.id+'">'+iconNote()+' View</button>'+
            '<button data-action="edit-test-data" data-id="'+t.id+'">'+iconEdit()+' Edit</button>'+
            '<button data-action="copy-test-data" data-id="'+t.id+'">'+iconCopy()+' Copy</button>'+
            '<button class="danger" data-action="delete-test-data" data-id="'+t.id+'">'+iconTrash()+' Delete</button>'+
          '</div>'+
        '</div>'+
      '</div>'+
    '</div>';
  }).join("")+'</div>'+pager;
}
function openTestDataViewModal(t){
  var body =
    '<div class="field"><label>National ID</label><p class="mono">'+esc(t.nationalId)+'</p></div>'+
    '<div class="field"><label>Supported Scenarios</label><p>'+(t.supportedScenarios||[]).map(function(s){return '<span class="chip">'+esc(s)+'</span>';}).join(" ")+'</p></div>'+
    '<div class="field"><label>Entities</label><p>'+((t.entities&&t.entities.length)? t.entities.map(function(en){return '<span class="chip chip-muted">'+esc(en)+'</span>';}).join(" ") : '<span class="helper-text">Not provided</span>')+'</p></div>'+
    '<div class="field"><label>Tags</label><p>'+((t.tags||[]).length? t.tags.map(function(tg){return '<span class="chip chip-muted">'+esc(tg)+'</span>';}).join(" ") : '<span class="helper-text">Not provided</span>')+'</p></div>'+
    '<div class="field"><label>Notes</label><p>'+(t.notes? esc(t.notes) : '<span class="helper-text">Not provided</span>')+'</p></div>'+
    '<div class="field"><label>Added</label><p class="helper-text">'+esc(t.createdBy||"Unknown")+' · '+esc(fmtDateTime(t.createdAt)||"")+'</p></div>';
  var foot = '<span style="flex:1"></span><button type="button" class="btn" data-action="close-modal">Close</button><button type="button" class="btn btn-primary" id="td-view-edit">'+iconEdit()+' Edit</button>';
  openModal('<div class="modal-head"><h3>Test Data — '+esc(t.nationalId)+'</h3><button class="btn btn-icon btn-ghost" data-action="close-modal" aria-label="Close">'+iconClose()+'</button></div><div class="modal-body">'+body+'</div><div class="modal-foot">'+foot+'</div>');
  var editBtn = qs("#td-view-edit");
  if(editBtn) editBtn.addEventListener("click", function(){ closeModal(); openTestDataModal(t, false); });
}
// existing: the record being edited/copied (null for a brand-new record).
// isCopyMode: true when opened via the "Copy" action — pre-fills every
// field except National ID (left blank so saving doesn't immediately
// collide with the record it was copied from) and always creates a new
// record on save, logging TEST_DATA_COPIED instead of TEST_DATA_CREATED.
function openTestDataModal(existing, isCopyMode){
  var isEdit = !!existing && !isCopyMode;
  var draft = isCopyMode
    ? {nationalId:"", supportedScenarios:(existing.supportedScenarios||[]).slice(), entities:(existing.entities||[]).slice(), tags:(existing.tags||[]).slice(), notes:existing.notes||""}
    : existing
      ? {nationalId:existing.nationalId, supportedScenarios:(existing.supportedScenarios||[]).slice(), entities:(existing.entities||[]).slice(), tags:(existing.tags||[]).slice(), notes:existing.notes||""}
      : {nationalId:"", supportedScenarios:[], entities:[], tags:[], notes:""};

  var all = allTestDataRecords();
  var scenarioOptions = distinct(TEST_DATA_SCENARIO_SUGGESTIONS.concat(all.reduce(function(acc,t){return acc.concat(t.supportedScenarios||[]);},[])));
  var entityOptions = distinct(TEST_DATA_ENTITY_SUGGESTIONS.concat(all.reduce(function(acc,t){return acc.concat(t.entities||[]);},[])));
  var tagOptions = distinct(all.reduce(function(acc,t){return acc.concat(t.tags||[]);},[]));

  var title = isEdit ? "Edit Test Data" : (isCopyMode ? "Copy Test Data" : "Add Test Data");
  var body =
    '<div class="field"><label for="f-td-nid">National ID</label><input type="text" id="f-td-nid" value="'+escAttr(draft.nationalId)+'" required placeholder="e.g. 9920123456"></div>'+
    '<div class="field"><label for="f-td-scenarios">Supported Scenarios</label><input type="text" id="f-td-scenarios" list="td-scenario-suggestions" value="'+escAttr(draft.supportedScenarios.join(", "))+'" required placeholder="e.g. Female Head of Family, Divorced"><span class="hint">Separate multiple scenarios with commas.</span></div>'+
    suggestionDatalist("td-scenario-suggestions", scenarioOptions)+
    '<div class="field"><label for="f-td-entity">Entities</label><input type="text" id="f-td-entity" list="td-entity-suggestions" value="'+escAttr(draft.entities.join(", "))+'" required placeholder="e.g. Family Book, Payments"><span class="hint">Separate multiple entities with commas.</span></div>'+
    suggestionDatalist("td-entity-suggestions", entityOptions)+
    '<div class="field"><label for="f-td-tags">Tags <span class="hint">(optional)</span></label><input type="text" id="f-td-tags" list="td-tag-suggestions" value="'+escAttr(draft.tags.join(", "))+'" placeholder="e.g. female-head, jordanian"><span class="hint">Separate multiple tags with commas.</span></div>'+
    suggestionDatalist("td-tag-suggestions", tagOptions)+
    '<div class="field"><label for="f-td-notes">Notes <span class="hint">(optional)</span></label><textarea id="f-td-notes" rows="3">'+esc(draft.notes)+'</textarea></div>'+
    '<div id="td-dup-warning" class="helper-text" style="display:none;color:var(--danger-fg);margin-top:-6px;"></div>';
  var foot = (isEdit? '<button type="button" class="btn btn-danger" id="del-test-data">'+iconTrash()+' Delete</button>' : '<span></span>')+
    '<span style="flex:1"></span><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">'+(isEdit?"Save changes":"Save")+'</button>';

  openModal(modalShell(title, body, foot));

  var delBtn = qs("#del-test-data");
  if(delBtn) delBtn.addEventListener("click", function(){
    closeModal();
    openConfirm("Delete this test data?", "This permanently deletes test data for National ID <b>"+esc(existing.nationalId)+"</b>.", "Delete", function(){ deleteTestDataRecord(existing.id); }, true);
  });

  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    var nationalId = qs("#f-td-nid").value.trim();
    if(!nationalId){ qs("#f-td-nid").focus(); return; }
    var scenarios = splitCommaList(qs("#f-td-scenarios").value);
    if(!scenarios.length){ qs("#f-td-scenarios").focus(); return; }
    var entities = splitCommaList(qs("#f-td-entity").value);
    if(!entities.length){ qs("#f-td-entity").focus(); return; }
    var tags = splitCommaList(qs("#f-td-tags").value);
    var notes = qs("#f-td-notes").value.trim();
    var payload = {nationalId:nationalId, supportedScenarios:scenarios, entities:entities, tags:tags, notes:notes};
    var submitBtn = qs('#modal-form button[type="submit"]');
    if(submitBtn) submitBtn.disabled = true;
    var warn = qs("#td-dup-warning");
    if(warn){ warn.style.display = "none"; warn.innerHTML = ""; }
    var req = isEdit ? api.updateTestData(existing.id, payload) : api.createTestData(payload);
    req.then(function(saved){
      state.testData[saved.id] = saved;
      if(state.testDataOrder.indexOf(saved.id)===-1) state.testDataOrder.unshift(saved.id);
      closeModal();
      if(state.route.view==="testData") render();
      logAudit({
        action: isEdit ? "TEST_DATA_UPDATED" : (isCopyMode ? "TEST_DATA_COPIED" : "TEST_DATA_CREATED"),
        entityType: "TestData", entityId: saved.id,
        details: saved.nationalId+((saved.entities&&saved.entities.length)? " — "+saved.entities.join(", "):"")
      });
      showToast(isEdit? "✓ Test data updated" : "✓ Test data saved");
    }).catch(function(err){
      if(submitBtn) submitBtn.disabled = false;
      if(err && err.status===409 && err.data && err.data.existingId){
        var exId = err.data.existingId;
        if(warn){
          warn.style.display = "block";
          warn.innerHTML = esc(err.message)+' <button type="button" class="btn btn-sm" id="td-open-existing" style="margin-left:6px;">Open existing record</button>';
          var openBtn = qs("#td-open-existing");
          if(openBtn) openBtn.addEventListener("click", function(){
            closeModal();
            var existingRec = state.testData[exId];
            if(existingRec) openTestDataModal(existingRec, false);
          });
        }
      } else {
        showToast(err.message || "Couldn't save test data.");
      }
    });
  });
}
function deleteTestDataRecord(id){
  var t = state.testData[id];
  api.deleteTestData(id).then(function(){
    delete state.testData[id];
    state.testDataOrder = state.testDataOrder.filter(function(x){return x!==id;});
    if(state.route.view==="testData") render();
    logAudit({action:"TEST_DATA_DELETED", entityType:"TestData", entityId:id, details: t? t.nationalId : id});
    showToast("Test data deleted");
  }).catch(function(e){ showToast("Couldn't delete: "+e.message); });
}

/* ============================================================
   EXPORT TEST DATA — downloads the currently searched/filtered view as
   an .xlsx (server-generated via exceljs — see routes/testData.js's
   GET /export). No search/filters active means the full table.
   ============================================================ */
function testDataExportUrl(){
  var params = [];
  if(state.testDataSearch) params.push("q="+encodeURIComponent(state.testDataSearch));
  if(state.testDataEntityFilter) params.push("entity="+encodeURIComponent(state.testDataEntityFilter));
  if(state.testDataTagFilter) params.push("tag="+encodeURIComponent(state.testDataTagFilter));
  return API+"/test-data/export"+(params.length? "?"+params.join("&") : "");
}
function triggerFileDownload(url){
  var a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
/* ============================================================
   IMPORT TEST DATA — read a spreadsheet export, review/fill whatever's
   missing (every record needs at least an Entity — the sheet columns
   this app knows about, ID and Feature/Scenario, don't carry one), and
   skip anything whose National ID is already in the table.
   CSV only (not raw .xlsx): parsing real .xlsx binaries needs a library,
   and the one on npm has open, unpatched high-severity vulnerabilities —
   not worth it when "File > Download > CSV" gets the same data across.
   ============================================================ */
function triggerTestDataImportFilePicker(){
  var input = document.getElementById("td-import-file-input");
  if(!input){
    input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.id = "td-import-file-input";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", function(){
      var file = input.files && input.files[0];
      input.value = ""; // so picking the same file again still fires "change"
      if(file) openTestDataImportModal(file);
    });
  }
  input.click();
}
// Minimal RFC4180-ish CSV parser — handles quoted fields, commas and
// newlines inside quotes, and doubled-quote ("") escaping. Good enough for
// spreadsheet exports; not a full spec implementation.
function parseCsvText(text){
  text = String(text||"").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  var rows = [], row = [], field = "", inQuotes = false;
  for(var i=0;i<text.length;i++){
    var c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if(c === '"'){ inQuotes = true; }
    else if(c === ','){ row.push(field); field = ""; }
    else if(c === '\n'){ row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  return rows;
}
// Column layout this app understands: A = National ID, B = Feature (mapped
// to Supported Scenarios), C = Notes; anything past that is ignored. Skips
// a header row if column A literally reads "ID". Rows sharing an ID (the
// sheet often lists the same person/case more than once) are merged into
// one record — their Feature/notes values are combined, deduped. Entities
// has no source column at all, so every returned row starts with none;
// that's what the review modal asks you to fill in.
function buildTestDataImportDraft(rows){
  var startIdx = (rows.length && String(rows[0][0]==null?"":rows[0][0]).trim().toLowerCase()==="id") ? 1 : 0;
  var byId = {}, order = [], noIdCount = 0;
  for(var i=startIdx;i<rows.length;i++){
    var r = rows[i];
    var id = String(r[0]==null?"":r[0]).trim();
    var feature = String(r[1]==null?"":r[1]).trim().replace(/\s+/g," ");
    var notes = String(r[2]==null?"":r[2]).trim().replace(/\s+/g," ");
    if(!id && !feature && !notes) continue; // fully blank row
    if(!id){ noIdCount++; continue; } // nothing to key this row on
    if(!byId[id]){ byId[id] = {id:id, scenarios:[], notes:[]}; order.push(id); }
    var rec = byId[id];
    if(feature && rec.scenarios.indexOf(feature)===-1) rec.scenarios.push(feature);
    if(notes && rec.notes.indexOf(notes)===-1) rec.notes.push(notes);
  }
  return {
    rows: order.map(function(id){
      var rec = byId[id];
      return {id: rec.id, scenarios: rec.scenarios, notes: rec.notes.join("; "), entities: []};
    }),
    noIdCount: noIdCount
  };
}
function openTestDataImportModal(file){
  var body = '<div id="td-import-status" class="helper-text">Reading '+esc(file.name)+'…</div><div id="td-import-body"></div>';
  var foot = '<button type="button" class="btn" data-action="close-modal" id="td-import-cancel-btn">Cancel</button>'+
    '<button type="button" class="btn btn-primary" id="td-import-submit-btn" disabled>'+iconSave()+' Import</button>';
  openModal(modalShell("Import Test Data", body, foot), {xwide:true});
  qs("#modal-form").addEventListener("submit", function(e){ e.preventDefault(); });

  var working = []; // rows still needing review/import; see buildTestDataImportDraft()
  var skippedExistingCount = 0;
  var noIdSkippedCount = 0;
  var bodyEl = qs("#td-import-body");
  var statusEl = qs("#td-import-status");
  var submitBtn = qs("#td-import-submit-btn");

  function rowMissing(row){
    var m = [];
    if(!row.scenarios.length) m.push("scenario");
    if(!row.entities.length) m.push("entity");
    return m;
  }
  function rowStatusPill(missing){
    return missing.length===0 ? '<span class="pill tone-go pill-sm">Ready</span>' : '<span class="pill tone-neutral pill-sm">Missing</span>';
  }
  function renderRowHtml(row, idx){
    var missing = rowMissing(row);
    return '<tr class="td-import-row'+(missing.length===0?' is-ready':'')+'" data-imp-idx="'+idx+'">'+
      '<td class="mono">'+esc(row.id)+'</td>'+
      '<td><input type="text" class="td-import-input" data-imp-field="scenario" data-imp-idx="'+idx+'" placeholder="e.g. Divorced, Electronic Payment" value="'+escAttr(row.scenarios.join(", "))+'"></td>'+
      '<td><input type="text" class="td-import-input" data-imp-field="notes" data-imp-idx="'+idx+'" placeholder="Notes" value="'+escAttr(row.notes||"")+'"></td>'+
      '<td><input type="text" class="td-import-input" data-imp-field="entity" data-imp-idx="'+idx+'" list="td-import-entity-suggestions" placeholder="e.g. Family Book" value="'+escAttr(row.entities.join(", "))+'"></td>'+
      '<td class="td-import-status-cell">'+rowStatusPill(missing)+'</td>'+
    '</tr>';
  }
  function refreshRowDom(idx){
    var row = working[idx];
    if(!row) return;
    var missing = rowMissing(row);
    var tr = qs('#td-import-tbody tr[data-imp-idx="'+idx+'"]');
    if(!tr) return;
    tr.classList.toggle("is-ready", missing.length===0);
    var statusCell = tr.querySelector(".td-import-status-cell");
    if(statusCell) statusCell.innerHTML = rowStatusPill(missing);
  }
  function updateFooter(){
    var readyCount = working.filter(function(row){ return rowMissing(row).length===0; }).length;
    submitBtn.hidden = false;
    submitBtn.disabled = readyCount===0;
    submitBtn.innerHTML = iconSave()+' Import '+readyCount+' ready row'+pluralize(readyCount,"","s");
  }
  function renderAll(){
    if(!working.length){
      var parts = [];
      if(skippedExistingCount) parts.push(skippedExistingCount+' already in Test Data');
      if(noIdSkippedCount) parts.push(noIdSkippedCount+' row'+pluralize(noIdSkippedCount,"","s")+' with no ID');
      statusEl.innerHTML = parts.length
        ? 'Nothing new to import from <b>'+esc(file.name)+'</b> — '+parts.join(", ")+' (all skipped).'
        : 'No importable rows found in <b>'+esc(file.name)+'</b>.';
      bodyEl.innerHTML = "";
      submitBtn.hidden = true;
      var cancelBtn = qs("#td-import-cancel-btn");
      if(cancelBtn) cancelBtn.textContent = "Close";
      return;
    }
    var summaryParts = [];
    if(skippedExistingCount) summaryParts.push(skippedExistingCount+' already in Test Data');
    if(noIdSkippedCount) summaryParts.push(noIdSkippedCount+' row'+pluralize(noIdSkippedCount,"","s")+' with no ID');
    statusEl.innerHTML = '<b>'+working.length+'</b> new record'+pluralize(working.length,"","s")+' found in <b>'+esc(file.name)+'</b>'+
      (summaryParts.length? ' ('+summaryParts.join(", ")+' skipped)':'')+
      '. Every record needs at least one <b>Entity</b> below — comma-separate for more than one.';
    var entitySuggestions = distinct(TEST_DATA_ENTITY_SUGGESTIONS.concat(allTestDataRecords().reduce(function(acc,t){return acc.concat(t.entities||[]);},[])));
    bodyEl.innerHTML =
      '<div class="td-import-bulkfill">'+
        '<input type="text" id="td-import-bulk-entity" list="td-import-entity-suggestions" placeholder="Apply an Entity to every row still missing one">'+
        '<button type="button" class="btn btn-sm" id="td-import-bulk-apply-btn">Apply to empty rows</button>'+
      '</div>'+
      '<datalist id="td-import-entity-suggestions">'+entitySuggestions.map(function(e){return '<option value="'+escAttr(e)+'">';}).join("")+'</datalist>'+
      '<div class="td-import-table-wrap"><table class="td-import-table"><thead><tr>'+
        '<th>ID</th><th>Scenario(s)</th><th>Notes</th><th>Entities</th><th></th>'+
      '</tr></thead><tbody id="td-import-tbody">'+
        working.map(renderRowHtml).join("")+
      '</tbody></table></div>';
    updateFooter();
  }

  // Bound once on the containers, not per-row — they read/mutate `working`
  // (and re-run after a partial import reassigns it), so they keep working
  // across renderAll() re-renders without re-attaching listeners.
  bodyEl.addEventListener("input", function(e){
    var input = e.target.closest(".td-import-input");
    if(!input) return;
    var idx = parseInt(input.getAttribute("data-imp-idx"), 10);
    var row = working[idx];
    if(!row) return;
    var field = input.getAttribute("data-imp-field");
    if(field==="scenario") row.scenarios = splitCommaList(input.value);
    else if(field==="entity") row.entities = splitCommaList(input.value);
    else if(field==="notes") row.notes = input.value.trim();
    refreshRowDom(idx);
    updateFooter();
  });
  bodyEl.addEventListener("click", function(e){
    if(!e.target.closest("#td-import-bulk-apply-btn")) return;
    var valInput = qs("#td-import-bulk-entity");
    var list = splitCommaList(valInput ? valInput.value : "");
    if(!list.length) return;
    working.forEach(function(row, idx){
      if(row.entities.length) return; // don't clobber a row already filled in by hand
      row.entities = list.slice();
      var tr = qs('#td-import-tbody tr[data-imp-idx="'+idx+'"]');
      var entInput = tr ? tr.querySelector('.td-import-input[data-imp-field="entity"]') : null;
      if(entInput) entInput.value = list.join(", ");
      refreshRowDom(idx);
    });
    updateFooter();
  });
  submitBtn.addEventListener("click", function(){
    var ready = working.filter(function(row){ return rowMissing(row).length===0; });
    if(!ready.length) return;
    submitBtn.disabled = true;
    submitBtn.textContent = "Importing…";
    var records = ready.map(function(row){
      return {nationalId: row.id, supportedScenarios: row.scenarios, entities: row.entities, tags: [], notes: row.notes||""};
    });
    api.bulkImportTestData(records).then(function(result){
      var created = result.created||[];
      created.forEach(function(rec){
        state.testData[rec.id] = rec;
        if(state.testDataOrder.indexOf(rec.id)===-1) state.testDataOrder.unshift(rec.id);
      });
      var createdIds = {};
      created.forEach(function(rec){ createdIds[rec.nationalId] = true; });
      working = working.filter(function(row){ return !createdIds[row.id]; });
      skippedExistingCount = 0; noIdSkippedCount = 0; // already communicated once
      if(state.route.view==="testData") render();
      logAudit({
        action: "TEST_DATA_IMPORTED", entityType: "TestData", entityId: "",
        details: created.length+" record(s) imported from "+file.name+(working.length? ", "+working.length+" row(s) left incomplete":"")
      });
      showToast("Imported "+created.length+" test data record"+pluralize(created.length,"","s")+(working.length? " — "+working.length+" row"+pluralize(working.length,"","s")+" still need info":"."));
      if(!working.length){ closeModal(); return; }
      renderAll();
    }).catch(function(e){
      showToast("Import failed: "+e.message);
      submitBtn.disabled = false;
      updateFooter();
    });
  });

  var reader = new FileReader();
  reader.onerror = function(){
    statusEl.innerHTML = '<div class="modal-error">Couldn\'t read that file.</div>';
    submitBtn.hidden = true;
  };
  reader.onload = function(){
    var text = String(reader.result||"");
    if(text.charCodeAt(0)===0xFEFF) text = text.slice(1); // strip a UTF-8 BOM (common from Excel's "CSV UTF-8" export)
    var rows;
    try{ rows = parseCsvText(text); } catch(e){ rows = []; }
    var built = buildTestDataImportDraft(rows);
    var existingIds = {};
    allTestDataRecords().forEach(function(t){ existingIds[t.nationalId] = true; });
    working = built.rows.filter(function(row){ return !existingIds[row.id]; });
    skippedExistingCount = built.rows.length - working.length;
    noIdSkippedCount = built.noIdCount;
    renderAll();
  };
  reader.readAsText(file, "UTF-8");
}

/* ============================================================
   INSTANT SEARCH (main page)
   A live, type-ahead dropdown over everything already loaded — release
   name/version/owner, plus tickets, bugs, blockers and regression entities/
   services inside every release — updating on every keystroke, with
   keyboard navigation and highlighted matches, the way Confluence's quick
   search works. Nothing is fetched for it; it searches what's already in
   memory from the release list.
   ============================================================ */
function renderSearchBar(){
  var q = state.searchQuery || "";
  return '<div class="search-wrap">'+
    '<div class="search-box">'+iconSearch()+
      '<input type="text" id="global-search" autocomplete="off" placeholder="Search releases, tickets, bugs, blockers, regression…" value="'+escAttr(q)+'">'+
      '<button type="button" class="search-clear" data-action="clear-search" aria-label="Clear search"'+(q?'':' hidden')+'>'+iconClose()+'</button>'+
    '</div>'+
    '<div class="search-dropdown" id="search-dropdown" hidden></div>'+
  '</div>';
}
function highlightMatch(text, q){
  var s = String(text==null?"":text);
  if(!q) return esc(s);
  var idx = s.toLowerCase().indexOf(q.toLowerCase());
  if(idx===-1) return esc(s);
  return esc(s.slice(0,idx))+"<mark>"+esc(s.slice(idx,idx+q.length))+"</mark>"+esc(s.slice(idx+q.length));
}
function buildSearchResults(query){
  var q = String(query||"").trim().toLowerCase();
  if(!q) return [];
  var results = [];
  state.releaseOrder.forEach(function(id){
    var r = state.releases[id];
    if(!r) return;
    var label = releaseLabel(r);
    var releaseHay = [r.name, r.version, r.qaOwner].filter(Boolean).join(" ").toLowerCase();
    if(releaseHay.indexOf(q)>-1){
      results.push({releaseId:id, kind:"Release", primary:label, secondary:r.qaOwner?("QA owner: "+r.qaOwner):"", scrollTo:null});
    }
    (r.tickets||[]).forEach(function(t){
      var hay = [t.key, t.title].filter(Boolean).join(" ").toLowerCase();
      if(hay.indexOf(q)>-1){
        results.push({releaseId:id, kind:"Ticket", primary:(t.key?t.key+" — ":"")+(t.title||"Untitled"), secondary:"in "+label, scrollTo:"sec-tickets"});
      }
    });
    (r.bugs||[]).forEach(function(b){
      var hay = [b.bugId, b.title].filter(Boolean).join(" ").toLowerCase();
      if(hay.indexOf(q)>-1){
        results.push({releaseId:id, kind:"Bug", primary:(b.bugId?b.bugId+" — ":"")+(b.title||"Untitled"), secondary:"in "+label, scrollTo:"sec-bugs"});
      }
    });
    (r.blockers||[]).forEach(function(bl){
      if((bl.title||"").toLowerCase().indexOf(q)>-1){
        results.push({releaseId:id, kind:"Blocker", primary:bl.title||"Untitled", secondary:"in "+label, scrollTo:"sec-blockers"});
      }
    });
    regressionEntities(r).forEach(function(ent){
      if((ent.name||"").toLowerCase().indexOf(q)>-1){
        results.push({releaseId:id, kind:"Regression", primary:ent.name||"Unnamed entity", secondary:"in "+label, scrollTo:"sec-regression"});
      }
      (ent.services||[]).forEach(function(s){
        if((s.name||"").toLowerCase().indexOf(q)>-1){
          results.push({releaseId:id, kind:"Regression", primary:(ent.name?ent.name+" – ":"")+(s.name||"Unnamed service"), secondary:"in "+label, scrollTo:"sec-regression"});
        }
      });
    });
  });
  return results.slice(0, 20);
}
function renderSearchDropdown(){
  var dd = qs("#search-dropdown");
  if(!dd) return;
  var q = state.searchQuery || "";
  if(!q.trim()){ dd.hidden = true; dd.innerHTML = ""; return; }
  var results = state.searchResults || [];
  if(!results.length){
    dd.innerHTML = '<div class="search-empty">No results for “'+esc(q)+'”</div>';
    dd.hidden = false;
    return;
  }
  dd.innerHTML = results.map(function(res, i){
    return '<div class="search-result'+(i===state.searchActiveIndex?' active':'')+'" data-action="open-search-result" data-result-index="'+i+'">'+
      '<span class="search-result-kind">'+esc(res.kind)+'</span>'+
      '<span class="search-result-primary">'+highlightMatch(res.primary, q)+'</span>'+
      (res.secondary ? '<span class="search-result-secondary">'+esc(res.secondary)+'</span>' : '')+
    '</div>';
  }).join("");
  dd.hidden = false;
}
function scrollActiveResultIntoView(){
  var dd = qs("#search-dropdown");
  if(!dd) return;
  var active = dd.querySelector(".search-result.active");
  if(active) active.scrollIntoView({block:"nearest"});
}
function closeSearchDropdown(){
  var dd = qs("#search-dropdown");
  if(dd){ dd.hidden = true; }
}
function openSearchResult(i){
  var res = (state.searchResults||[])[i];
  if(!res) return;
  state.pendingScrollTo = res.scrollTo || null;
  state.searchQuery = "";
  state.searchResults = [];
  state.searchActiveIndex = -1;
  goTo("#/r/"+res.releaseId);
}

/* ============================================================
   RENDER: DETAIL
   ============================================================ */
function renderDetail(r){
  var a = computeAssessment(r);
  var tone = toneForStatus(a.recommendation);
  var html = "";

  var published = r.published && r.published.at;
  html += '<div class="back-link" data-action="nav-list">'+iconBack()+' All releases</div>';
  html += '<div class="detail-header"><div>'+
    '<div class="detail-title-row"><h1>'+esc(r.name||"Untitled release")+'</h1><span class="detail-ver">'+esc(r.version||"")+'</span>'+pill(a.recommendation, tone, "pill-lg")+
      (published ? pill("🚀 Published "+fmtDate(r.published.at), "go") : "")+'</div>'+
    '<div class="detail-meta">'+
      '<span>'+iconCalendar()+' <b>'+esc(fmtDate(r.date))+'</b></span>'+
      '<span>'+iconUser()+' QA Owner: <b>'+esc(r.qaOwner||"Not provided")+'</b></span>'+
    '</div></div>'+
    '<div class="detail-actions">'+
      '<button class="btn btn-sm" data-action="edit-release-info">'+iconEdit()+' Edit info</button>'+
      '<button class="btn btn-sm" data-action="duplicate-release" data-id="'+r._id+'">'+iconCopy()+' Duplicate</button>'+
      (published ? '<button class="btn btn-sm" data-action="download-release-pdf">'+iconDownload()+' Download PDF</button>' : '')+
      '<div style="position:relative;">'+
        '<button class="btn btn-sm btn-icon" data-action="toggle-release-menu" aria-label="More actions">'+iconDots()+'</button>'+
        '<div class="menu" id="release-menu"><button class="danger" data-action="delete-release" data-id="'+r._id+'">'+iconTrash()+' Delete release</button></div>'+
      '</div>'+
    '</div>'+
  '</div>';

  html += '<nav class="quicknav">'+
    ['tickets','regression','bugs','incidents','platforms','blockers','performance','security','notes','mobile','publish'].map(function(s){
      var labels={tickets:"Tickets",regression:"Regression",bugs:"Bugs",incidents:"Incidents",platforms:"Platforms",blockers:"Blockers",performance:"Performance",security:"Security",notes:"Release Notes",mobile:"Mobile Release Note",publish:"Publish"};
      return '<a data-scroll="sec-'+s+'">'+labels[s]+'</a>';
    }).join("")+
  '</nav>';

  html += '<div class="ai-card">'+
    '<div class="ai-card-head"><div class="ai-card-label">'+iconSpark()+' AI Release Assessment</div>'+pill(a.recommendation, tone, "pill-lg")+'</div>'+
    '<div class="ai-summary">'+esc(a.summary)+'</div>'+
    (a.risks.length ? '<div class="ai-risks">'+a.risks.slice(0,6).map(function(x){return '<div class="ai-risk-item"><span class="dot" style="background:var(--'+(x.tone==='danger'?'danger-fg':x.tone==='warn'?'warn-fg':x.tone==='info'?'info-fg':'neutral-fg')+');"></span><span>'+x.text+'</span></div>';}).join("")+'</div>'
      : '<div class="ai-risks-empty">No risk factors identified from the information entered.</div>') +
  '</div>';

  html += sectionTickets(r);
  html += sectionRegression(r);
  html += sectionBugs(r);
  html += sectionIncidents(r);
  html += sectionPlatforms(r);
  html += sectionBlockers(r);
  html += sectionPerformance(r);
  html += sectionSecurity(r);
  html += sectionReleaseNotes(r);
  html += sectionMobileNote(r);
  html += sectionPublish(r, a);

  return html;
}

/* ============================================================
   DOWNLOAD PDF — a standalone report built from the release's data,
   *not* a styled copy of the page above. Built fresh into #pdf-report
   right before window.print() (see the "download-release-pdf" action
   below); only @media print shows that container (see styles.css) —
   the live page is hidden while it's on screen. Covers exactly: the AI
   summary, ticket/regression/bug statistics, the ticket list with
   status, and the release notes.
   ============================================================ */
function pdfStatTile(n, label){
  return '<div class="pdf-stat-tile"><div class="pdf-stat-num">'+esc(n)+'</div><div class="pdf-stat-label">'+esc(label)+'</div></div>';
}
// Used as the document title right before printing, since that's what
// browsers suggest as the default filename in the print/Save-as-PDF
// dialog — strip characters that aren't safe in a filename on any OS.
function pdfFileName(r){
  var raw = (r.name||"Untitled release") + (r.version? " "+r.version : "");
  return raw.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}
function buildPdfReportHtml(r){
  var a = computeAssessment(r);
  var tone = toneForStatus(a.recommendation);
  var published = r.published && r.published.at;
  var tickets = r.tickets || [];
  var tSum = ticketSummary(r);
  var regC = regressionCounts(r);
  var bugs = r.bugs || [];
  var bugCounts = {Critical:0, High:0, Medium:0, Low:0};
  bugs.forEach(function(b){ if(bugCounts.hasOwnProperty(b.severity)) bugCounts[b.severity]++; });

  var html = "";

  html += '<div class="pdf-header">'+
    '<div class="pdf-brand">Greenlight — Release Monitor</div>'+
    '<div class="pdf-title-row">'+
      '<span class="pdf-title">'+esc(r.name||"Untitled release")+'</span>'+
      (r.version? '<span class="pdf-version">'+esc(r.version)+'</span>' : '')+
      pill(a.recommendation, tone, "pill-lg")+
    '</div>'+
    '<div class="pdf-meta">'+
      '<span>Date: <b>'+esc(fmtDate(r.date))+'</b></span>'+
      '<span>QA Owner: <b>'+esc(r.qaOwner||"Not provided")+'</b></span>'+
      (published? '<span>Published: <b>'+esc(fmtDateTime(r.published.at))+'</b></span>' : '')+
    '</div>'+
  '</div>';

  html += '<div class="pdf-section">'+
    '<div class="pdf-section-title">Summary</div>'+
    '<div class="pdf-summary-text">'+esc(a.summary)+'</div>'+
    (a.risks.length ? '<ul class="pdf-risks">'+a.risks.map(function(x){ return '<li>'+x.text+'</li>'; }).join("")+'</ul>' : '')+
  '</div>';

  html += '<div class="pdf-section">'+
    '<div class="pdf-section-title">Statistics</div>'+
    '<div class="pdf-stat-group">'+
      '<div class="pdf-stat-group-label">Tickets</div>'+
      '<div class="pdf-stats-grid">'+
        pdfStatTile(tSum.total,"Total")+pdfStatTile(tSum.completed,"Completed")+pdfStatTile(tSum.inQA,"In QA")+pdfStatTile(tSum.blocked,"Blocked")+pdfStatTile(tSum.open,"Open / To Do")+
      '</div>'+
    '</div>'+
    '<div class="pdf-stat-group">'+
      '<div class="pdf-stat-group-label">Regression ('+regC.total+' service'+pluralize(regC.total,"","s")+')</div>'+
      '<div class="pdf-stats-grid">'+
        pdfStatTile(regC.passed,"Passed")+pdfStatTile(regC.warn,"Warning")+pdfStatTile(regC.fail,"Failed")+pdfStatTile(regC.notTested,"Not Tested")+pdfStatTile(regC.skipped,"Skipped")+
      '</div>'+
    '</div>'+
    '<div class="pdf-stat-group">'+
      '<div class="pdf-stat-group-label">Bugs</div>'+
      '<div class="pdf-stats-grid">'+
        pdfStatTile(bugCounts.Critical,"Critical")+pdfStatTile(bugCounts.High,"High")+pdfStatTile(bugCounts.Medium,"Medium")+pdfStatTile(bugCounts.Low,"Low")+
      '</div>'+
    '</div>'+
  '</div>';

  html += '<div class="pdf-section">'+
    '<div class="pdf-section-title">Tickets ('+tickets.length+')</div>'+
    (tickets.length ?
      '<table class="pdf-table"><thead><tr><th>Key</th><th>Title</th><th>Status</th><th>Type</th><th>Priority</th></tr></thead><tbody>'+
        tickets.map(function(t){
          return '<tr><td>'+esc(t.key)+'</td><td>'+esc(t.title||"Untitled")+'</td>'+
            '<td>'+pill(t.status||"Unknown", toneForStatus(t.bucket))+'</td>'+
            '<td>'+esc(t.issueType||"—")+'</td><td>'+esc(t.priority||"—")+'</td></tr>';
        }).join("")+
      '</tbody></table>'
      : '<p class="pdf-empty">No tickets on this release.</p>')+
  '</div>';

  var notesHtml = (r.releaseNotes && r.releaseNotes.html) ? r.releaseNotes.html : "";
  html += '<div class="pdf-section pdf-section-last">'+
    '<div class="pdf-section-title">Release Notes</div>'+
    (notesHtml.trim() ? '<div class="pdf-notes">'+notesHtml+'</div>' : '<p class="pdf-empty">No release notes written yet.</p>')+
  '</div>';

  html += '<div class="pdf-footer">Generated from Greenlight on '+esc(fmtDateTime(new Date().toISOString()))+'</div>';

  return html;
}

function afterDetailRender(r){
  var editor = qs("#notes-editor");
  if(editor){
    editor.innerHTML = r.releaseNotes && r.releaseNotes.html ? r.releaseNotes.html : "";
    state.notesDirty = false;
    updateNotesStatus(r);
  }
  if(qs("#mrn-en")){
    state.mobileNoteDirty = false;
    updateMobileNoteStatus(r);
    updateMobileNoteCounters();
  }
  if(state.pendingScrollTo){
    var targetId = state.pendingScrollTo;
    state.pendingScrollTo = null;
    setTimeout(function(){
      var el = document.getElementById(targetId);
      if(el) el.scrollIntoView({behavior:"smooth", block:"start"});
    }, 30);
  }
  // The AI assessment is computed live on every render, but that's not a
  // discrete user action worth an audit trail on its own — log it once per
  // release per viewing (first time this release is opened this session),
  // not on every subsequent re-render caused by an edit.
  if(!state.assessmentLoggedFor[r._id]){
    state.assessmentLoggedFor[r._id] = true;
    var a = computeAssessment(r);
    logAudit({action:"AI_ASSESSMENT_GENERATED", entityType:"Release", entityId:r._id, details:"Recommendation: "+a.recommendation});
  }
}

/* ---- Tickets ---- */
function ticketSummary(r){
  var tickets = r.tickets || [];
  var out = {total: tickets.length, completed:0, inQA:0, blocked:0, open:0};
  tickets.forEach(function(t){
    if(t.bucket==="Completed") out.completed++;
    else if(t.bucket==="In QA") out.inQA++;
    else if(t.bucket==="Blocked") out.blocked++;
    else out.open++;
  });
  return out;
}
function priorityRank(p){
  var order = {"highest":0,"blocker":0,"critical":0,"high":1,"major":1,"medium":2,"normal":2,"low":3,"minor":3,"lowest":4};
  var key = String(p||"").toLowerCase();
  return order.hasOwnProperty(key) ? order[key] : 50;
}
// Team members offered for a ticket's QA assignee — the full Know the Team
// roster, as members (id + name). Deliberately NOT narrowed by Regression's
// "Available for regression assignment" toggle: QA ownership of a ticket is a
// separate concept from covering an Entity's regression, so someone can be
// eligible for one and not the other.
function ticketAssigneeOptions(){
  return allTeamMembers().filter(function(m){ return !!m.name; });
}
/* ---- Ticket QA assignment: a Know the Team member id, per release ----
   ticket.assignedTo is a team member's id (or null). The tickets live inside
   each release's own document, so assigning MOJ-1240 in Release A never
   touches MOJ-1240 in Release B.
   The KEY being present marks a manual choice (null = deliberately
   unassigned) and always wins. A ticket with no assignedTo key just follows
   Jira's own "QA Assigned" field (ticket.qaAssignedFromJira, refreshed on
   every sync): those are display names from Jira, so they're matched to a
   team member by (unique, punctuation/case-insensitive) name purely as a
   read-time convenience — nothing about that match is stored as identity.
   A re-sync from Jira only ever refreshes qaAssignedFromJira, never
   assignedTo. (Older releases that stored a names array in ticket.qaAssignee
   are converted to this shape server-side — see server/assignmentLogic.js.) */
function ticketHasManualAssignee(ticket){
  return !!(ticket && Object.prototype.hasOwnProperty.call(ticket, "assignedTo"));
}
function ticketJiraNames(ticket){
  var v = ticket && ticket.qaAssignedFromJira;
  var list = Array.isArray(v) ? v : (v ? [v] : []);
  return list.map(function(x){ return (x||"").toString().trim(); }).filter(Boolean);
}
// Same name with every space/punctuation mark removed ("Al-irani" and
// "Alirani" and "Al Irani" all read the same).
function compactName(name){ return normalizeNameForSuggestion(name).replace(/ /g, ""); }
// The names that identify a member in Jira: their Know the Team name plus any
// "Jira name(s)" they were given there (member.jiraNames) for when Jira
// spells them differently.
function memberJiraKeys(m){
  var keys = [compactName(m.name)];
  (Array.isArray(m.jiraNames) ? m.jiraNames : []).forEach(function(n){ keys.push(compactName(n)); });
  return keys.filter(Boolean);
}
// Jira display name -> team member id, only when exactly one member claims it.
function memberIdForJiraName(name){
  var key = compactName(name);
  if(!key) return "";
  var hits = allTeamMembers().filter(function(m){ return memberJiraKeys(m).indexOf(key)>-1; });
  return hits.length===1 ? hits[0].id : "";
}
// Names kept from the old name-based model for a ticket whose manual QA
// assignee couldn't be matched to a member then (see server/assignmentLogic.js).
function ticketLegacyNames(ticket){
  var v = ticket && ticket.legacyQaAssignee;
  return (Array.isArray(v) ? v : []).map(function(x){ return (x||"").toString().trim(); }).filter(Boolean);
}
// A ticket can have MORE THAN ONE QA owner (Jira's "QA Assigned" is a
// multi-person field). `ticket.assignedTo` holds one member id, or an array
// of ids when there are several; null / [] = deliberately nobody.
function ticketAssignedIdsRaw(ticket){
  var v = ticket && ticket.assignedTo;
  var list = Array.isArray(v) ? v : (v ? [v] : []);
  var seen = {};
  return list.filter(function(id){ if(typeof id!=="string" || !id || seen[id]) return false; seen[id]=true; return true; });
}
// Everyone a ticket is effectively assigned to, as [{id, label}]:
//  - a manual choice (assignedTo key present) always wins: those members, plus
//    any old name that still matches nobody (shown as typed);
//  - otherwise Jira's QA Assigned names: the matching member's name when
//    there is one (see memberIdForJiraName), else the name exactly as Jira
//    gives it — so a person who isn't in Know the Team is still shown.
function ticketAssigneeEntries(ticket){
  var out = [], seen = {};
  function add(id, label){
    var key = id ? "id:"+id : "n:"+compactName(label);
    if(!label || seen[key]) return;
    seen[key] = true; out.push({id:id||"", label:label});
  }
  if(!ticket) return out;
  if(ticketHasManualAssignee(ticket)){
    ticketAssignedIdsRaw(ticket).forEach(function(id){ add(id, memberNameById(id)); });
    ticketLegacyNames(ticket).forEach(function(n){
      var id = memberIdForJiraName(n);
      if(id) add(id, memberNameById(id)); else add("", n);
    });
  } else {
    ticketJiraNames(ticket).forEach(function(n){
      var id = memberIdForJiraName(n);
      if(id) add(id, memberNameById(id)); else add("", n);
    });
  }
  return out;
}
// Just the Know the Team member ids among them ([] = nobody).
function ticketAssignedMemberIds(ticket){
  return ticketAssigneeEntries(ticket).filter(function(e){ return e.id; }).map(function(e){ return e.id; });
}
function ticketAssigneeLabel(ticket){
  return ticketAssigneeEntries(ticket).map(function(e){ return e.label; }).join(", ");
}
function renderTicketAssigneeBtn(t){
  var label = ticketAssigneeLabel(t) || "Unassigned";
  var has = !!ticketAssigneeEntries(t).length;
  var manual = ticketHasManualAssignee(t);
  var title = manual
    ? (has ? "Manually assigned — click to change" : "Explicitly set to Unassigned — click to change")
    : (has ? "Synced from Jira's QA Assigned field — click to override" : "Assign a QA owner");
  return '<button type="button" class="btn btn-sm btn-ghost regression-owner-btn'+(has?" has-owner":"")+'" data-action="edit-ticket-assignee" data-key="'+escAttr(t.key)+'" title="'+escAttr(title)+'">'+iconUser()+' '+esc(label)+'</button>';
}
function groupTickets(tickets, mode){
  if(mode==="None"){
    return [{key:"__all__", label:"All Tickets", items:tickets.slice()}];
  }
  var buckets = {};
  if(mode==="QA Assignee"){
    // A ticket can have more than one QA owner — it's filed under EVERY one
    // of its assignees (not just the first), so a ticket assigned to two
    // people shows up in both of their buckets. A ticket with nobody
    // assigned lands in Unassigned instead.
    tickets.forEach(function(t){
      var entries = ticketAssigneeEntries(t);
      if(!entries.length){
        (buckets["Unassigned"] = buckets["Unassigned"]||[]).push(t);
      } else {
        entries.forEach(function(e){ (buckets[e.label] = buckets[e.label]||[]).push(t); });
      }
    });
  } else {
    var field = mode==="Status" ? "bucket" : mode==="Priority" ? "priority" : "issueType";
    tickets.forEach(function(t){
      var v = (t[field]||"").toString().trim() || "Not provided";
      (buckets[v] = buckets[v]||[]).push(t);
    });
  }
  var keys = Object.keys(buckets);
  if(mode==="Status"){
    keys.sort(function(a,b){ return TICKET_BUCKETS.indexOf(a) - TICKET_BUCKETS.indexOf(b); });
  } else if(mode==="Priority"){
    keys.sort(function(a,b){ var d = priorityRank(a)-priorityRank(b); return d!==0? d : a.localeCompare(b); });
  } else if(mode==="QA Assignee"){
    // Alphabetical by assignee, with the Unassigned bucket always last.
    keys.sort(function(a,b){
      if(a==="Unassigned" && b!=="Unassigned") return 1;
      if(b==="Unassigned" && a!=="Unassigned") return -1;
      return a.localeCompare(b);
    });
  } else {
    keys.sort(function(a,b){ return a.localeCompare(b); });
  }
  return keys.map(function(k){ return {key:mode+":"+k, label:k, items:buckets[k]}; });
}
function sectionTickets(r){
  var tickets = r.tickets || [];
  var summary = ticketSummary(r);
  var js = state.jiraStatus || {connected:false};
  var lastSynced = r.jira && r.jira.lastSyncedAt ? fmtDateTime(r.jira.lastSyncedAt) : null;

  var groups = groupTickets(tickets, state.ticketGroupBy);
  var groupsHtml = tickets.length ? groups.map(function(g){
    // "All Tickets" (no grouping) starts expanded; grouped buckets start
    // collapsed by default to stay compact, until the user expands one.
    var collapsed = state.ticketGroupBy==="None" ? false :
      (g.key in state.ticketCollapsed ? state.ticketCollapsed[g.key] : true);
    var rows = g.items.map(function(t){
      return '<div class="ticket-row">'+
        '<span class="ticket-key">'+esc(t.key)+'</span>'+
        '<span class="ticket-title">'+esc(t.title||"Untitled")+'</span>'+
        '<span class="ticket-tags">'+
          pill(t.status||"Unknown", toneForStatus(t.bucket))+
          '<span class="badge '+(t.priority==="Critical"||t.priority==="Highest"?"":"")+'">'+esc(t.priority||"Not provided")+'</span>'+
          '<span class="badge">'+esc(t.issueType||"Not provided")+'</span>'+
          '<span class="badge '+(t.source==="Jira"?"badge-jira":"badge-manual")+'">'+esc(t.source||"Manual")+'</span>'+
        '</span>'+
        renderTicketAssigneeBtn(t)+
        '<a class="ticket-open-link" href="'+escAttr(t.url||"#")+'" target="_blank" rel="noopener noreferrer">Open '+iconLink()+'</a>'+
        '<span class="ticket-actions">'+
          '<button class="btn btn-sm btn-icon" data-action="edit-ticket" data-key="'+escAttr(t.key)+'" aria-label="Edit ticket">'+iconEdit()+'</button>'+
          '<button class="btn btn-sm btn-icon btn-danger" data-action="delete-ticket" data-key="'+escAttr(t.key)+'" aria-label="Remove ticket">'+iconTrash()+'</button>'+
        '</span>'+
      '</div>';
    }).join("");
    return '<div class="ticket-group'+(collapsed?"":" expanded")+'" data-group-key="'+escAttr(g.key)+'">'+
      '<div class="ticket-group-head" data-action="toggle-ticket-group" data-key="'+escAttr(g.key)+'">'+
        '<span class="chev">▶</span><span class="ticket-group-title">'+esc(g.label)+'</span><span class="ticket-group-count">('+g.items.length+')</span>'+
      '</div>'+
      '<div class="ticket-group-body">'+rows+'</div>'+
    '</div>';
  }).join("") : '<div class="empty-row">No tickets yet. Add one by Jira URL, or connect Jira to sync a release version automatically.</div>';

  return '<section class="card section-card" id="sec-tickets">'+
    '<div class="section-head"><div class="section-title"><span class="emoji">🎫</span> Tickets Within the Release</div>'+
      '<div class="section-actions">'+
        (js.connected? "" : '<a class="btn btn-sm" href="/auth/login">'+iconJira()+' Reconnect Jira</a>')+
        '<button class="btn btn-sm" data-action="resync-jira" '+(js.connected? "":"disabled title=\"Sign in with Atlassian first\"")+'>'+iconRefresh()+' Re-sync Jira</button>'+
        '<button class="btn btn-sm btn-primary" data-action="add-ticket">'+iconPlus()+' Add Ticket</button>'+
      '</div></div>'+
    '<div class="section-body">'+
      '<div class="ticket-stats">'+
        statTile(summary.total,"Total")+statTile(summary.completed,"Completed")+statTile(summary.inQA,"In QA")+statTile(summary.blocked,"Blocked")+statTile(summary.open,"Open / To Do")+
      '</div>'+
      '<div class="ticket-meta-row">'+
        '<span class="jira-status-line"><span class="jira-dot '+(js.connected?"on":"off")+'"></span>'+(js.connected? "Jira connected" : "Jira not connected — sign in with Atlassian")+'</span>'+
        '<span>Fix Version match: <b class="mono">'+esc(r.version || "not set")+'</b></span>'+
        (lastSynced ? '<span>Last synced: <b>'+esc(lastSynced)+'</b></span>' : '<span class="helper-text">Never synced</span>')+
      '</div>'+
      '<div class="ticket-controls"><label class="helper-text" for="ticket-group-by">Group by</label>'+
        '<select id="ticket-group-by">'+TICKET_GROUP_MODES.map(function(m){return '<option value="'+m+'" '+(m===state.ticketGroupBy?"selected":"")+'>'+m+'</option>';}).join("")+'</select>'+
      '</div>'+
      groupsHtml+
    '</div>'+
  '</section>';
}
function statTile(n, label){
  return '<div class="stat-tile"><div class="num">'+n+'</div><div class="label">'+label+'</div></div>';
}

/* ---- Regression ---- */
// A segmented row of status buttons for one service — clicking a status
// saves immediately (no modal), same pattern as the Performance/Security
// enable toggles. Notes are edited separately via a small popup (see
// openRegressionNotesModal), reached through the row's notes button.
function regressionStatusButtons(entityId, s){
  return '<div class="status-choice regression-status-choice">'+REG_STATUSES.map(function(opt){
    var inputId = "regstatus-"+s.id+"-"+opt.replace(/[^A-Za-z0-9]/g,"");
    return '<input type="radio" name="regstatus-'+s.id+'" id="'+inputId+'" value="'+esc(opt)+'" '+
      'data-action="set-regression-status" data-entity-id="'+esc(entityId)+'" data-id="'+esc(s.id)+'" '+(opt===s.status?"checked":"")+'>'+
      '<label for="'+inputId+'" class="tone-'+toneForStatus(opt)+'">'+esc(opt)+'</label>';
  }).join("")+'</div>';
}
// Same segmented status control as regressionStatusButtons, but scoped to
// the Entity itself rather than one of its services — used only when the
// entity has no services configured, so there's otherwise no status control
// for it at all (see renderRegressionEntityGroup).
function regressionEntityStatusButtons(entity){
  var current = entity.status || "NOT TESTED";
  return '<div class="status-choice regression-status-choice">'+REG_STATUSES.map(function(opt){
    var inputId = "regentstatus-"+entity.id+"-"+opt.replace(/[^A-Za-z0-9]/g,"");
    return '<input type="radio" name="regentstatus-'+entity.id+'" id="'+inputId+'" value="'+esc(opt)+'" '+
      'data-action="set-regression-entity-status" data-entity-id="'+esc(entity.id)+'" '+(opt===current?"checked":"")+'>'+
      '<label for="'+inputId+'" class="tone-'+toneForStatus(opt)+'">'+esc(opt)+'</label>';
  }).join("")+'</div>';
}
// Compact horizontal card for one module: name + its assignee on the first
// line, status pills + the existing notes ("comment") button on the second,
// and — only when someone other than the assignee last changed the status —
// a collapsed one-line "changed by another QA member" note. `entity` is
// passed through so set-regression-status/edit-regression-notes can carry the
// entity id they need (both re-look-up their real target by id — see the
// click delegation switch — so this render never needs to be a live
// reference).
function regressionModuleAssigneeBtn(entity, s){
  if(entity._legacy) return ""; // a legacy flat row IS its own entity — assigned via the entity control
  var id = regressionModuleAssigneeId(entity, s);
  var override = regressionModuleHasOverride(s);
  var title = override ? (id ? "Assigned to this module — click to change" : "Deliberately unassigned — click to change")
                       : (id ? "Follows the Entity owner — click to give this module its own" : "No one — click to assign");
  var label = id ? memberNameById(id) : (override ? "Unassigned" : "Assign");
  return '<button type="button" class="btn btn-sm btn-ghost regression-owner-btn regression-module-owner'+(id?" has-owner":"")+(override?" is-override":"")+'" data-action="edit-regression-module-owner" data-entity-id="'+escAttr(entity.id)+'" data-id="'+escAttr(s.id)+'" title="'+escAttr(title)+'">'+iconUser()+' '+esc(label)+'</button>';
}
function renderRegressionServiceRow(entity, s){
  var holder = entity._legacy ? entity._legacy : s;
  return '<div class="item-row regression-service-row'+(s.status==='FAIL'?' is-flagged':'')+'">'+
    '<div class="reg-row-top">'+
      '<div class="reg-row-name">'+esc(s.name||"Unnamed service")+'</div>'+
      regressionModuleAssigneeBtn(entity, s)+
    '</div>'+
    '<div class="reg-row-bottom">'+
      regressionStatusButtons(entity.id, s)+
      '<div class="item-row-actions reg-row-actions">'+
        '<button type="button" class="btn btn-sm btn-icon" data-action="edit-regression-notes" data-entity-id="'+entity.id+'" data-id="'+s.id+'" aria-label="'+(s.notes?"Edit":"Add")+' notes" title="'+(s.notes?"Edit":"Add")+' notes">'+iconNote()+'</button>'+
      '</div>'+
    '</div>'+
    regressionChangeNoteHtml(holder, s.status)+
    (s.notes? '<div class="item-row-desc reg-row-notes">'+esc(s.notes)+'</div>':'')+
  '</div>';
}
function renderRegressionEntityGroup(entity){
  var services = entity.services||[];
  var ownerId = entity.assignedTo || "";
  var legacyOwner = !ownerId && entity.legacyOwner ? entity.legacyOwner : "";
  var ownerLabel = ownerId ? memberNameById(ownerId) : (legacyOwner ? legacyOwner+" (not in Know the Team)" : "Assign owner");
  var ownerBtnHtml = '<button type="button" class="btn btn-sm btn-ghost regression-owner-btn'+(ownerId?" has-owner":"")+'" data-action="edit-regression-owner" data-entity-id="'+entity.id+'" title="'+(ownerId?"Change owner":"Assign an owner")+'">'+iconUser()+' '+esc(ownerLabel)+'</button>';
  if(!services.length){
    // No services under this entity (e.g. a page that isn't broken into
    // sub-services) — track regression status on the entity itself as a
    // single item instead of leaving it with no status control at all.
    // Reuses the same row markup/classes as a service row (regression-
    // service-row, reg-row-*) so it looks and behaves consistently.
    var entStatus = entity.status || "NOT TESTED";
    return '<div class="regression-entity-group">'+
      '<div class="regression-entity-heading-row">'+
        '<div class="regression-entity-heading-main">'+
          '<div class="regression-entity-heading">'+esc(entity.name||"Unnamed entity")+'</div>'+
          '<div class="regression-entity-summary">No services configured — tracked as one item</div>'+
        '</div>'+
        ownerBtnHtml+
      '</div>'+
      '<div class="item-list"><div class="item-row regression-service-row'+(entStatus==="FAIL"?" is-flagged":"")+'">'+
        '<div class="reg-row-top"><div class="reg-row-name">Overall status</div></div>'+
        '<div class="reg-row-bottom">'+regressionEntityStatusButtons(entity)+
          '<div class="item-row-actions reg-row-actions">'+
            '<button type="button" class="btn btn-sm btn-icon" data-action="edit-regression-entity-notes" data-entity-id="'+entity.id+'" aria-label="'+(entity.notes?"Edit":"Add")+' notes" title="'+(entity.notes?"Edit":"Add")+' notes">'+iconNote()+'</button>'+
          '</div>'+
        '</div>'+
        regressionChangeNoteHtml(entity, entStatus)+
        (entity.notes? '<div class="item-row-desc reg-row-notes">'+esc(entity.notes)+'</div>':'')+
      '</div></div>'+
    '</div>';
  }
  var rows = services.map(function(s){ return renderRegressionServiceRow(entity, s); }).join("");
  return '<div class="regression-entity-group">'+
    '<div class="regression-entity-heading-row">'+
      '<div class="regression-entity-heading-main">'+
        '<div class="regression-entity-heading">'+esc(entity.name||"Unnamed entity")+'</div>'+
        '<div class="regression-entity-summary">'+esc(regressionEntitySummaryLine(entity))+'</div>'+
      '</div>'+
      ownerBtnHtml+
    '</div>'+
    '<div class="item-list">'+rows+'</div>'+
  '</div>';
}
// Buckets MODULES by their effective assignee (member id): each bucket holds
// the entities that have at least one module assigned to that member, as
// copies carrying only those modules. Nobody-assigned modules land in one
// "Unassigned" bucket, always last so the named members sort first.
function groupRegressionByOwner(entities){
  var buckets = {}; // member id (or "") -> {label, entities, byEntity}
  function bucketFor(id){
    var key = id || "";
    if(!buckets[key]) buckets[key] = { label: id ? memberNameById(id) : "Unassigned", entities: [], byEntity: {} };
    return buckets[key];
  }
  entities.forEach(function(entity){
    var services = entity.services||[];
    if(!services.length){ bucketFor(entity.assignedTo||"").entities.push(entity); return; }
    services.forEach(function(s){
      var b = bucketFor(regressionModuleAssigneeId(entity, s));
      var slot = b.byEntity[entity.id];
      if(!slot){ slot = Object.assign({}, entity, {services:[]}); b.byEntity[entity.id] = slot; b.entities.push(slot); }
      slot.services.push(s);
    });
  });
  var named = Object.keys(buckets).filter(function(k){return k!=="";}).sort(function(a,b){ return buckets[a].label.localeCompare(buckets[b].label); }).map(function(k){ return buckets[k]; });
  if(buckets[""]) named.push(buckets[""]);
  return named;
}
function sectionRegression(r){
  var skipped = !!r.regressionSkipped;
  var entities = regressionEntities(r);
  var overall = regressionOverallStatus(r);
  // The three views (All/My Regression/Unassigned) narrow which modules
  // render, by their effective assignee — regressionStatLine/the overall pill above
  // still reflect the whole release regardless of view, same as Group By
  // already only ever changed layout, never what counted toward the
  // release's own status.
  var viewEntities = filterRegressionEntitiesForView(entities, state.regressionView);
  var groupsHtml;
  if(state.regressionGroupBy === "Owner"){
    groupsHtml = groupRegressionByOwner(viewEntities).map(function(g){
      return '<div class="regression-owner-group">'+
        '<div class="regression-owner-group-heading">'+iconUser()+' '+esc(g.label)+'<span class="regression-owner-group-count">('+g.entities.length+')</span></div>'+
        g.entities.map(renderRegressionEntityGroup).join("")+
      '</div>';
    }).join("");
  } else {
    groupsHtml = viewEntities.map(renderRegressionEntityGroup).join("");
  }
  var viewTabs = '<div class="regression-view-tabs">'+["All","Mine","Unassigned"].map(function(v){
    var label = v==="Mine" ? "My Regression" : v;
    return '<button type="button" class="btn btn-sm view-tab'+(state.regressionView===v?" active":"")+'" data-action="set-regression-view" data-view="'+v+'">'+esc(label)+'</button>';
  }).join("")+'</div>';
  var listOrEmpty;
  if(!entities.length){
    listOrEmpty = '<div class="empty-row">No regression modules on this release yet. Click “Sync Modules” to pull in your entity/service list (or “Manage Modules” to set one up first).</div>';
  } else if(!viewEntities.length){
    // "My Regression" came up empty — before assuming nothing's actually
    // assigned, check for a Know the Team entry that's very likely the
    // signed-in user under a slightly different spelling (see
    // suggestedMyTeamMember) and offer a one-click way to confirm it, right
    // here, instead of sending them off to Know the Team to link it by hand.
    var meSuggestion = state.regressionView==="Mine" ? suggestedMyTeamMember() : null;
    var needsLink = state.regressionView==="Mine" && !currentMemberId() && !meSuggestion && allTeamMembers().length;
    listOrEmpty = '<div class="empty-row">'+(state.regressionView==="Mine"
      ? ("Nothing is assigned to you yet."+(currentMemberId() ? "" : " Link yourself to your Know the Team entry so it can tell which regression is yours."))
      : "Everything has an owner.")+
      (meSuggestion ? '<div class="regression-me-suggestion">Is <strong>'+esc(meSuggestion.name)+'</strong> you? '+
        '<button type="button" class="btn btn-sm btn-primary" data-action="toggle-my-team-member" data-id="'+meSuggestion.id+'">'+iconUser()+' Yes, that’s me</button></div>' : '')+
      (needsLink ? '<div class="regression-me-suggestion"><button type="button" class="btn btn-sm btn-primary" data-action="link-identity">'+iconUser()+' Pick your Know the Team entry</button></div>' : '')+
      '</div>';
  } else {
    listOrEmpty = '<div class="regression-entity-list">'+groupsHtml+'</div>';
  }
  var body = skipped
    ? '<div class="disabled-note">Regression: marked as not required for this release</div>'
    : '<p class="helper-text" style="margin-bottom:16px;">'+esc(regressionStatLine(r))+'</p>'+
      (entities.length ? viewTabs : '')+
      (entities.length ? '<div class="regression-controls"><label class="helper-text" for="regression-group-by">Group by</label>'+
          '<select id="regression-group-by">'+REGRESSION_GROUP_MODES.map(function(m){return '<option value="'+m+'" '+(m===state.regressionGroupBy?"selected":"")+'>'+m+'</option>';}).join("")+'</select>'+
        '</div>' : '')+
      listOrEmpty;
  return '<section class="card section-card" id="sec-regression">'+
    '<div class="section-head"><div class="section-title"><span class="emoji">🔄</span> Regression</div>'+
      '<div class="section-actions">'+
        (skipped ? pill("⏭ SKIPPED","neutral") : pill(regressionStatusEmoji(overall)+" "+overall, regressionOverallTone(overall)))+
        '<span class="regression-skip-toggle">Skip regression'+toggleSwitch("regression-skip", skipped, "Mark regression as not required for this release")+'</span>'+
        (skipped || !entities.length ? '' : '<button class="btn btn-sm" data-action="open-assign-regression">'+iconUser()+' Assign Regression</button>')+
        (skipped ? '' : '<button class="btn btn-sm" data-action="sync-regression-modules">'+iconRefresh()+' Sync Modules</button>')+
        '<button class="btn btn-sm" data-action="manage-regression-modules">'+iconGear()+' Manage Modules</button>'+
      '</div></div>'+
    '<div class="section-body">'+body+'</div>'+
  '</section>';
}

/* ---- Bugs ---- */
function sectionBugs(r){
  var bugs = r.bugs||[];
  var counts = {Critical:0,High:0,Medium:0,Low:0};
  bugs.forEach(function(b){ if(counts.hasOwnProperty(b.severity)) counts[b.severity]++; });
  var highlighted = bugs.filter(function(b){ return b.status==="Open" && (b.severity==="Critical"||b.severity==="High"); });

  var rows = bugs.map(function(b){
    var flagged = b.status==="Open" && (b.severity==="Critical"||b.severity==="High");
    return '<div class="item-row'+(flagged?' is-flagged':'')+'">'+
      '<div class="item-row-main"><div class="item-row-title">'+(b.bugId?'<span class="id-tag">'+esc(b.bugId)+'</span>':'')+' '+esc(b.title||"Untitled bug")+
        pill(b.severity, toneForStatus(b.severity))+pill(b.status, toneForStatus(b.status))+'</div>'+
        (b.notes? '<div class="item-row-desc">'+esc(b.notes)+'</div>':'')+'</div>'+
      '<div class="item-row-actions">'+
        '<button class="btn btn-sm btn-icon" data-action="edit-bug" data-id="'+b.id+'" aria-label="Edit bug">'+iconEdit()+'</button>'+
        '<button class="btn btn-sm btn-icon btn-danger" data-action="delete-bug" data-id="'+b.id+'" aria-label="Delete bug">'+iconTrash()+'</button>'+
      '</div></div>';
  }).join("");

  return '<section class="card section-card" id="sec-bugs">'+
    '<div class="section-head"><div class="section-title"><span class="emoji">🐛</span> Known Bugs</div>'+
      '<div class="section-actions"><button class="btn btn-sm" data-action="add-bug">'+iconPlus()+' Add bug</button></div></div>'+
    '<div class="section-body">'+
      '<div class="ticket-stats" style="grid-template-columns:repeat(4,1fr);">'+
        statTile(counts.Critical,"Critical")+statTile(counts.High,"High")+statTile(counts.Medium,"Medium")+statTile(counts.Low,"Low")+
      '</div>'+
      (highlighted.length ? '<div style="margin-bottom:14px;"><div class="helper-text" style="margin-bottom:8px;font-weight:700;color:var(--danger-fg);">Open critical / high severity</div><div class="item-list">'+
        highlighted.map(function(b){
          return '<div class="item-row is-flagged"><div class="item-row-main"><div class="item-row-title">'+(b.bugId?'<span class="id-tag">'+esc(b.bugId)+'</span>':'')+' '+esc(b.title||"Untitled bug")+pill(b.severity,toneForStatus(b.severity))+'</div></div></div>';
        }).join("")+'</div></div>' : '') +
      (bugs.length ? '<div class="item-list">'+rows+'</div>' : '<div class="empty-row">No bugs logged for this release yet.</div>') +
    '</div>'+
  '</section>';
}

/* ---- Incidents ----
   Small, release-scoped records of things that went wrong around a release —
   either tied to ONE of this release's tickets (scope "TICKET") or about the
   release as a whole (scope "RELEASE"). Stored on the release itself
   (r.incidents[], same as r.bugs / r.blockers) and saved through the same
   full-document PUT; the server re-validates every save (see
   server/incidentLogic.js), including that a ticket-level incident only
   points at a ticket from this very release. ticketId is the ticket's Jira
   key — tickets here have no other id. Deliberately lightweight: a card list
   with a summary line and three filters, nothing more. */
function incidentIsUnresolved(inc){ return !!inc && inc.status!=="Resolved"; }
function findIncident(r, id){ return (r.incidents||[]).find(function(x){return x.id===id;}) || null; }
function incidentTicket(r, inc){
  if(!inc || inc.scope!=="TICKET" || !inc.ticketId) return null;
  return (r.tickets||[]).find(function(t){return t.key===inc.ticketId;}) || null;
}
function incidentScopeFromType(typeLabel){
  return typeLabel===INCIDENT_TYPE_TICKET ? "TICKET" : (typeLabel===INCIDENT_TYPE_RELEASE ? "RELEASE" : "");
}
// "Payment service timeout (MOJ-1240)" / "Production deployment delay" — used
// in assessment risk lines, where the reader needs to know what and where.
function incidentTitleWithRef(inc){
  return (inc.title||"Untitled incident")+(inc.scope==="TICKET" && inc.ticketId ? " ("+inc.ticketId+")" : "");
}
// HTML-escaped, capped to two names so a long list can't flood the AI card.
function incidentTitlesText(r, list){
  var shown = list.slice(0,2).map(function(i){ return esc(incidentTitleWithRef(i)); }).join(", ");
  return shown + (list.length>2 ? " +"+(list.length-2)+" more" : "");
}
// What the Audit Log shows: "MOJ-1240 — Payment service timeout" for a
// ticket-level incident, just the title for a release-level one.
function incidentAuditDetails(inc){
  return (inc.scope==="TICKET" && inc.ticketId ? inc.ticketId+" — " : "")+(inc.title||"Untitled incident");
}
function incidentCounts(incidents){
  var c = {total:incidents.length, open:0, investigating:0, resolved:0};
  incidents.forEach(function(i){
    if(i.status==="Resolved") c.resolved++;
    else if(i.status==="Investigating") c.investigating++;
    else c.open++;
  });
  return c;
}
// "3 incidents · 1 open · 2 resolved" — only non-zero buckets are listed.
function incidentSummaryLine(incidents){
  var c = incidentCounts(incidents);
  var parts = [c.total+" incident"+pluralize(c.total,"","s")];
  if(c.open) parts.push(c.open+" open");
  if(c.investigating) parts.push(c.investigating+" investigating");
  if(c.resolved) parts.push(c.resolved+" resolved");
  return parts.join(" · ");
}
function incidentSeverityDot(sev){
  return (sev==="Critical"||sev==="High") ? "🔴" : (sev==="Medium" ? "🟠" : "🟡");
}
function incidentFilterFor(r){
  var f = state.incidentFilters[r._id] || {};
  return {scope:f.scope||"All", severity:f.severity||"", status:f.status||""};
}
function filterIncidents(incidents, f){
  return incidents.filter(function(i){
    if(f.scope==="TICKET" && i.scope!=="TICKET") return false;
    if(f.scope==="RELEASE" && i.scope!=="RELEASE") return false;
    if(f.severity && i.severity!==f.severity) return false;
    if(f.status && i.status!==f.status) return false;
    return true;
  });
}
// Filters only re-render this one section (not the whole page), so changing
// one never throws away unsaved edits in the Release Notes editor below.
function setIncidentFilter(r, key, value){
  var f = incidentFilterFor(r);
  f[key] = value;
  state.incidentFilters[r._id] = f;
  var sec = qs("#sec-incidents");
  if(sec) sec.outerHTML = sectionIncidents(r);
  else render();
}
function incidentCardHtml(r, inc){
  var ticket = incidentTicket(r, inc);
  var flagged = incidentIsUnresolved(inc) && (inc.severity==="Critical"||inc.severity==="High");
  var scopeHtml;
  if(inc.scope==="TICKET"){
    scopeHtml = '🎫 '+(ticket ? jiraKeyHtml(ticket) : esc(inc.ticketId||""))+
      (ticket && ticket.title ? ' — '+esc(ticket.title) : '')+
      (ticket ? '' : ' <span class="hint">(no longer in this release)</span>');
  } else {
    scopeHtml = 'Release-level incident';
  }
  var id = esc(inc.id);
  return '<div class="incident-card'+(flagged?' is-flagged':'')+'" data-incident-id="'+id+'">'+
    '<div class="incident-card-head">'+
      '<div class="incident-card-title"><span class="incident-sev-dot" aria-hidden="true">'+incidentSeverityDot(inc.severity)+'</span><span>'+esc(inc.title||"Untitled incident")+'</span></div>'+
      '<div class="incident-card-actions">'+
        '<button class="btn btn-sm btn-icon" data-action="toggle-incident-menu" data-id="'+id+'" aria-label="More actions">'+iconDots()+'</button>'+
        '<div class="menu" id="incident-menu-'+id+'">'+
          '<button data-action="view-incident" data-id="'+id+'">'+iconEye()+' View</button>'+
          '<button data-action="edit-incident" data-id="'+id+'">'+iconEdit()+' Edit</button>'+
          '<button class="danger" data-action="delete-incident" data-id="'+id+'">'+iconTrash()+' Delete</button>'+
        '</div>'+
      '</div>'+
    '</div>'+
    '<div class="incident-card-scope">'+scopeHtml+'</div>'+
    '<div class="incident-card-meta">'+pill(inc.severity||"Medium", toneForStatus(inc.severity), "pill-sm")+pill(inc.status||"Open", toneForStatus(inc.status), "pill-sm")+'</div>'+
    '<div class="incident-card-desc">'+esc(inc.description||"")+'</div>'+
    (inc.impact ? '<div class="incident-card-impact"><span class="incident-card-impact-label">Impact:</span> '+esc(inc.impact)+'</div>' : '')+
  '</div>';
}
function sectionIncidents(r){
  var all = r.incidents||[];
  var f = incidentFilterFor(r);
  var visible = filterIncidents(all, f).slice().sort(function(a,b){
    return String(b.createdAt||"").localeCompare(String(a.createdAt||"")); // newest first
  });
  var scopeLabels = {All:"All", TICKET:"Ticket Incidents", RELEASE:"Release Incidents"};
  var controls = all.length
    ? '<div class="incident-controls">'+
        ["All","TICKET","RELEASE"].map(function(k){
          return '<button type="button" class="btn btn-sm view-tab'+(f.scope===k?" active":"")+'" data-action="set-incident-scope" data-scope="'+k+'">'+scopeLabels[k]+'</button>';
        }).join("")+
        '<span class="incident-filter-spacer"></span>'+
        '<select data-action="set-incident-filter" data-filter="severity" aria-label="Filter by severity"><option value="">Severity: All</option>'+
          INCIDENT_SEVERITIES.map(function(v){return '<option value="'+v+'"'+(f.severity===v?" selected":"")+'>'+v+'</option>';}).join("")+'</select>'+
        '<select data-action="set-incident-filter" data-filter="status" aria-label="Filter by status"><option value="">Status: All</option>'+
          INCIDENT_STATUSES.map(function(v){return '<option value="'+v+'"'+(f.status===v?" selected":"")+'>'+v+'</option>';}).join("")+'</select>'+
      '</div>'
    : '';
  var listHtml = !all.length
    ? '<div class="empty-row">No incidents recorded for this release.</div>'
    : (visible.length
        ? '<div class="incident-list">'+visible.map(function(i){ return incidentCardHtml(r, i); }).join("")+'</div>'
        : '<div class="empty-row">No incidents match these filters.</div>');
  return '<section class="card section-card" id="sec-incidents">'+
    '<div class="section-head"><div class="section-title"><span class="emoji">🚨</span> Incidents</div>'+
      '<div class="section-actions"><button class="btn btn-sm" data-action="add-incident">'+iconPlus()+' Add Incident</button></div></div>'+
    '<div class="section-body">'+
      '<div class="incident-summary" style="margin-bottom:12px;">'+esc(incidentSummaryLine(all))+'</div>'+
      controls+listHtml+
    '</div>'+
  '</section>';
}
// Shared by the Add/Edit modal and unit-testable on its own. Returns an error
// message, or "" when valid. A ticket-level incident must link to one of THIS
// release's own tickets — the only exception is an existing incident that
// keeps its current link even though Jira sync has since dropped that ticket
// (so editing its status doesn't force a re-link). Mirrors the server rules.
function validateIncidentInput(r, existing, v){
  if(!v.scope) return "Choose an incident type.";
  if(v.scope==="TICKET"){
    if(!v.ticketId) return "Select the release ticket this incident is related to.";
    var inRelease = (r.tickets||[]).some(function(t){ return t.key===v.ticketId; });
    var keptLink = !!existing && existing.scope==="TICKET" && existing.ticketId===v.ticketId;
    if(!inRelease && !keptLink) return "That ticket isn't part of this release.";
  }
  if(!v.title) return "Incident title is required.";
  if(!v.description) return "Description is required.";
  return "";
}
// Saves a new incidents array through the normal full-release PUT, and — unlike
// the older sections — rolls the local copy back if the server rejects it, so
// a rejected save never leaves a ghost incident on screen.
function persistIncidents(r, nextIncidents, onSaved){
  var prev = r.incidents;
  r.incidents = nextIncidents;
  return api.saveRelease(r._id, r).then(function(updated){
    state.releases[r._id] = updated;
    render();
    if(onSaved) onSaved();
  }).catch(function(e){
    r.incidents = prev;
    showToast((e && e.message) || "Couldn't save the incident.");
    var sec = qs("#sec-incidents");
    if(sec) sec.outerHTML = sectionIncidents(r);
  });
}
function openIncidentModal(r, existing){
  var inc = existing || {scope:"", ticketId:"", title:"", severity:"Medium", status:"Open", description:"", impact:"", resolution:""};
  var tickets = r.tickets||[];
  var currentType = inc.scope==="TICKET" ? INCIDENT_TYPE_TICKET : (inc.scope==="RELEASE" ? INCIDENT_TYPE_RELEASE : "");
  var ticketOptions = '<option value="">Select ticket…</option>'+tickets.map(function(t){
    return '<option value="'+escAttr(t.key)+'"'+(t.key===inc.ticketId?' selected':'')+'>'+esc(t.key+(t.title? " — "+t.title : ""))+'</option>';
  }).join("");
  // An existing incident whose ticket has since left the release keeps its
  // link visible (and selected) instead of silently dropping it.
  if(inc.scope==="TICKET" && inc.ticketId && !tickets.some(function(t){return t.key===inc.ticketId;})){
    ticketOptions += '<option value="'+escAttr(inc.ticketId)+'" selected>'+esc(inc.ticketId+" — (no longer in this release)")+'</option>';
  }
  var body =
    '<div class="field"><label>Incident Type *</label>'+statusChoiceGroup("incident-type", [INCIDENT_TYPE_TICKET, INCIDENT_TYPE_RELEASE], currentType, true)+'</div>'+
    '<div class="field" id="incident-ticket-field" style="'+(currentType===INCIDENT_TYPE_TICKET?'':'display:none;')+'">'+
      '<label for="f-ticket">Release Ticket *</label><select id="f-ticket">'+ticketOptions+'</select>'+
      (tickets.length ? '' : '<span class="helper-text">This release has no tickets yet — add a ticket first, or choose “Release-level incident”.</span>')+
    '</div>'+
    '<div class="field"><label for="f-title">Incident Title *</label><input type="text" id="f-title" maxlength="200" value="'+escAttr(inc.title)+'" placeholder="Short summary of what happened"></div>'+
    '<div class="field"><label>Severity</label>'+statusChoiceGroup("incident-severity", INCIDENT_SEVERITIES, inc.severity)+'</div>'+
    '<div class="field"><label>Status</label>'+statusChoiceGroup("incident-status", INCIDENT_STATUSES, inc.status)+'</div>'+
    '<div class="field"><label for="f-desc">Description *</label><textarea id="f-desc" rows="3" maxlength="2000" placeholder="What happened?">'+esc(inc.description||"")+'</textarea></div>'+
    '<div class="field"><label for="f-impact">Impact <span class="hint">(optional)</span></label><textarea id="f-impact" rows="2" maxlength="1000" placeholder="Who or what was affected?">'+esc(inc.impact||"")+'</textarea></div>'+
    '<div class="field"><label for="f-resolution">Resolution <span class="hint">(optional)</span></label><textarea id="f-resolution" rows="2" maxlength="1000" placeholder="How was it resolved?">'+esc(inc.resolution||"")+'</textarea></div>'+
    '<div id="incident-form-error"></div>';
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Save Incident</button>';
  openModal(modalShell(existing? "Edit incident" : "Add incident", body, foot));
  var form = qs("#modal-form");
  // The ticket picker only exists for "Related to a ticket".
  form.addEventListener("change", function(e){
    if(!e.target || e.target.name!=="incident-type") return;
    var tf = qs("#incident-ticket-field");
    if(tf) tf.style.display = e.target.value===INCIDENT_TYPE_TICKET ? "" : "none";
  });
  form.addEventListener("submit", function(e){
    e.preventDefault();
    var v = {
      scope: incidentScopeFromType((qs('input[name="incident-type"]:checked')||{}).value||""),
      ticketId: "",
      title: qs("#f-title").value.trim(),
      severity: (qs('input[name="incident-severity"]:checked')||{}).value || "Medium",
      status: (qs('input[name="incident-status"]:checked')||{}).value || "Open",
      description: qs("#f-desc").value.trim(),
      impact: qs("#f-impact").value.trim(),
      resolution: qs("#f-resolution").value.trim()
    };
    if(v.scope==="TICKET") v.ticketId = (qs("#f-ticket").value||"").trim();
    var err = validateIncidentInput(r, existing, v);
    var errEl = qs("#incident-form-error");
    if(err){
      if(errEl) errEl.innerHTML = '<div class="incident-form-error">'+esc(err)+'</div>';
      return;
    }
    var now = new Date().toISOString();
    var fields = {
      scope:v.scope, ticketId: v.scope==="TICKET" ? v.ticketId : null, // release-level never keeps a ticket link
      title:v.title, severity:v.severity, status:v.status,
      description:v.description, impact:v.impact, resolution:v.resolution
    };
    var isNew = !existing;
    var saved = isNew
      ? Object.assign({id:crypto.randomUUID(), releaseId:r._id}, fields, {createdBy:currentPreparerName(), createdAt:now, updatedAt:now})
      : Object.assign({}, existing, fields, {updatedAt:now});
    var current = r.incidents||[];
    var next = isNew ? current.concat([saved]) : current.map(function(x){ return x.id===existing.id ? saved : x; });
    closeModal();
    persistIncidents(r, next, function(){
      logAudit({action: isNew ? "INCIDENT_CREATED" : "INCIDENT_UPDATED", entityType:"Incident", entityId:saved.id, details:incidentAuditDetails(saved)});
    });
  });
}
function openIncidentViewModal(r, inc){
  var ticket = incidentTicket(r, inc);
  var ticketHtml = inc.scope==="TICKET"
    ? (ticket ? jiraKeyHtml(ticket)+(ticket.title? " — "+esc(ticket.title) : "") : esc(inc.ticketId||"")+' <span class="hint">(no longer in this release)</span>')
    : "";
  function row(label, valueHtml){ return '<dt>'+label+'</dt><dd>'+valueHtml+'</dd>'; }
  var body = '<dl class="incident-view-grid">'+
    row("Title", esc(inc.title||"Untitled incident"))+
    row("Type", inc.scope==="TICKET" ? "Ticket-level incident" : "Release-level incident")+
    (inc.scope==="TICKET" ? row("Ticket", ticketHtml) : "")+
    row("Severity", pill(inc.severity||"Medium", toneForStatus(inc.severity), "pill-sm"))+
    row("Status", pill(inc.status||"Open", toneForStatus(inc.status), "pill-sm"))+
    row("Description", esc(inc.description||"—"))+
    row("Impact", esc(inc.impact||"—"))+
    row("Resolution", esc(inc.resolution||"—"))+
    row("Reported by", esc(inc.createdBy||"—"))+
    row("Created", esc(fmtDateTime(inc.createdAt)||"—"))+
    row("Last updated", esc(fmtDateTime(inc.updatedAt)||"—"))+
  '</dl>';
  var foot = '<span style="flex:1"></span><button type="button" class="btn" data-action="close-modal">Close</button>'+
    '<button type="button" class="btn btn-primary" data-action="edit-incident" data-id="'+esc(inc.id)+'">'+iconEdit()+' Edit</button>';
  openModal(modalShell("Incident details", body, foot));
}
function confirmDeleteIncident(r, inc){
  openConfirm("Delete this incident?", "<b>"+esc(inc.title||"Untitled incident")+"</b> will be removed from this release.", "Delete", function(){
    var next = (r.incidents||[]).filter(function(x){ return x.id!==inc.id; });
    persistIncidents(r, next, function(){
      logAudit({action:"INCIDENT_DELETED", entityType:"Incident", entityId:inc.id, details:incidentAuditDetails(inc)});
    });
  }, true);
}

/* ---- Platforms ---- */
function sectionPlatforms(r){
  var tiles = ["web","android","ios"].map(function(k){
    var p = r.platforms[k];
    return '<div class="platform-tile"><div class="platform-tile-top"><div class="platform-name">'+PLATFORM_LABELS[k]+'</div>'+pill(p.status, toneForStatus(p.status))+'</div>'+
      (p.notes? '<div class="platform-notes">'+esc(p.notes)+'</div>' : '<div class="platform-notes helper-text">No notes</div>')+
      '<div style="margin-top:10px;"><button class="btn btn-sm" data-action="edit-platform" data-key="'+k+'">'+iconEdit()+' Edit</button></div>'+
    '</div>';
  }).join("");
  return '<section class="card section-card" id="sec-platforms">'+
    '<div class="section-head"><div class="section-title"><span class="emoji">📱</span> Platforms</div></div>'+
    '<div class="section-body"><div class="platform-grid">'+tiles+'</div></div>'+
  '</section>';
}

/* ---- Blockers ---- */
function sectionBlockers(r){
  var blockers = r.blockers||[];
  var unresolved = blockers.filter(function(b){return b.status!=="Resolved";});
  var rows = blockers.map(function(b){
    var flagged = b.status!=="Resolved";
    return '<div class="item-row'+(flagged?' is-flagged':'')+'">'+
      '<div class="item-row-main"><div class="item-row-title">'+esc(b.title||"Untitled blocker")+pill(b.status, toneForStatus(b.status))+'</div>'+
      (b.description? '<div class="item-row-desc">'+esc(b.description)+'</div>':'')+
      (b.owner? '<div class="item-row-sub">Owner: '+esc(b.owner)+'</div>':'')+'</div>'+
      '<div class="item-row-actions">'+
        '<button class="btn btn-sm btn-icon" data-action="edit-blocker" data-id="'+b.id+'" aria-label="Edit blocker">'+iconEdit()+'</button>'+
        '<button class="btn btn-sm btn-icon btn-danger" data-action="delete-blocker" data-id="'+b.id+'" aria-label="Delete blocker">'+iconTrash()+'</button>'+
      '</div></div>';
  }).join("");
  return '<section class="card section-card" id="sec-blockers">'+
    '<div class="section-head"><div class="section-title"><span class="emoji">🚫</span> Release Blockers</div>'+
      '<div class="section-actions">'+(unresolved.length? pill(unresolved.length+" unresolved","danger") : pill("None open","go"))+'<button class="btn btn-sm" data-action="add-blocker">'+iconPlus()+' Add blocker</button></div></div>'+
    '<div class="section-body">'+
      (blockers.length ? '<div class="item-list">'+rows+'</div>' : '<div class="empty-row">No release blockers logged. Great — but keep checking as testing continues.</div>') +
    '</div>'+
  '</section>';
}

/* ---- Performance ---- */
function sectionPerformance(r){
  var p = r.performance||{enabled:false};
  var body;
  if(!p.enabled){
    body = '<div class="disabled-note">Performance Testing: Not included in this release</div>';
  } else {
    body = '<div class="metric-grid">'+
      metricTile(p.responseTime||"Not provided","Response Time")+
      metricTile(p.concurrentUsers||"Not provided","Concurrent Users")+
      metricTile(p.errorRate||"Not provided","Error Rate")+
      metricTile(p.sla||"Not provided","SLA / Threshold")+
      '</div>'+
      (p.notes? '<p class="helper-text" style="margin-top:12px;">'+esc(p.notes)+'</p>':'');
  }
  return '<section class="card section-card" id="sec-performance">'+
    '<div class="section-head"><div class="section-title"><span class="emoji">⚡</span> Performance</div>'+
      '<div class="section-actions">'+(p.enabled? pill(p.status, toneForStatus(p.status)):'')+toggleSwitch("performance", p.enabled)+
        (p.enabled? '<button class="btn btn-sm" data-action="edit-performance">'+iconEdit()+' Edit</button>':'')+
      '</div></div>'+
    '<div class="section-body">'+body+'</div>'+
  '</section>';
}
function metricTile(v,k){
  return '<div class="metric-tile"><div class="v">'+esc(String(v))+'</div><div class="k">'+k+'</div></div>';
}

/* ---- Security ---- */
function sectionSecurity(r){
  var s = r.security||{enabled:false};
  var body;
  if(!s.enabled){
    body = '<div class="disabled-note">Security Testing: Not included in this release</div>';
  } else {
    body = '<div class="metric-grid">'+
      metricTile(num(s.critical),"Critical")+metricTile(num(s.high),"High")+metricTile(num(s.medium),"Medium")+metricTile(num(s.low),"Low")+
      '</div>'+
      (s.notes? '<p class="helper-text" style="margin-top:12px;">'+esc(s.notes)+'</p>':'');
  }
  return '<section class="card section-card" id="sec-security">'+
    '<div class="section-head"><div class="section-title"><span class="emoji">🔐</span> Security</div>'+
      '<div class="section-actions">'+(s.enabled? pill(s.status, toneForStatus(s.status)):'')+toggleSwitch("security", s.enabled)+
        (s.enabled? '<button class="btn btn-sm" data-action="edit-security">'+iconEdit()+' Edit</button>':'')+
      '</div></div>'+
    '<div class="section-body">'+body+'</div>'+
  '</section>';
}
function toggleSwitch(name, checked, title){
  return '<label class="switch" title="'+esc(title||("Enable "+name+" testing"))+'"><input type="checkbox" id="toggle-'+name+'" data-action="toggle-'+name+'" '+(checked?"checked":"")+'><span class="switch-track"></span></label>';
}

/* ---- Release Notes ---- */
function sectionReleaseNotes(r){
  return '<section class="card section-card" id="sec-notes">'+
    '<div class="section-head"><div class="section-title">📝 Release Notes</div>'+
      '<div class="section-actions">'+
        '<button class="btn btn-sm" data-action="generate-notes">'+iconSpark()+' Generate Release Notes</button>'+
        '<button class="btn btn-sm btn-primary" data-action="save-notes">'+iconSave()+' Save Release Notes</button>'+
      '</div></div>'+
    '<div class="section-body">'+
      '<div class="notes-toolbar">'+
        tbBtn("bold","<b>B</b>")+tbBtn("italic","<i>I</i>")+'<span class="tb-sep"></span>'+
        tbBtn("h2","H2")+tbBtn("h3","H3")+tbBtn("p","¶")+'<span class="tb-sep"></span>'+
        tbBtn("ul","&#8226; List")+
      '</div>'+
      '<div class="notes-editor" id="notes-editor" contenteditable="true" data-placeholder="Click ‘Generate Release Notes’ to draft notes from your QA data, or start typing your own."></div>'+
      '<div class="notes-status" id="notes-status"></div>'+
    '</div>'+
  '</section>';
}
function tbBtn(cmd, label){ return '<button type="button" class="tb-btn" data-notes-cmd="'+cmd+'">'+label+'</button>'; }
function updateNotesStatus(r){
  var el = qs("#notes-status");
  if(!el) return;
  var savedAt = r.releaseNotes && r.releaseNotes.savedAt ? fmtDateTime(r.releaseNotes.savedAt) : null;
  var bits = [];
  if(state.notesDirty) bits.push('<span class="dirty-dot"></span> Unsaved changes');
  else if(savedAt) bits.push("Saved "+savedAt);
  else bits.push("Not saved yet");
  el.innerHTML = bits.join(" ");
}

/* ---- Mobile Release Note ----
   The short, store-facing "What's New" bullets required by the App Store /
   Play Store submission forms — deliberately separate from the detailed,
   categorized Release Notes above (sectionReleaseNotes): this is a handful
   of short plain-language lines, one per line, in English and Arabic, that
   get copied out in the exact <en-US>/<ar> tagged format the store listing
   tooling expects (see handleCopyMobileNote). "Draft from tickets" and
   "Translate from English" are optional AI-assisted starting points (see
   server/mobileReleaseNoteLogic.js) — every bullet stays freely editable in
   the textareas below before you save or copy. */
// Google Play's "What's new" field (and, comfortably, Apple's App Store
// "What's New in This Version") caps store release-note text per language
// at 500 characters — enforced here as a hard ceiling on each textarea's
// whole value (maxlength, so typing/pasting past it is simply blocked) plus
// a live "n / 500" counter. server/mobileReleaseNoteLogic.js hardcodes the
// same number as MAX_BLOCK_LEN for its own server-side truncation (Draft/
// Translate results can't rely on maxlength, since they're set
// programmatically) — keep both in sync if this ever changes.
var MOBILE_NOTE_MAX_LEN = 500;
function sectionMobileNote(r){
  var mrn = r.mobileReleaseNote || {enUS:"", ar:"", savedAt:null};
  return '<section class="card section-card" id="sec-mobile">'+
    '<div class="section-head"><div class="section-title">📱 Mobile Release Note</div>'+
      '<div class="section-actions">'+
        '<button class="btn btn-sm" data-action="copy-mobile-note">'+iconCopy()+' Copy formatted block</button>'+
        '<button class="btn btn-sm btn-primary" data-action="save-mobile-note">'+iconSave()+' Save</button>'+
      '</div></div>'+
    '<div class="section-body">'+
      '<p class="helper-text">The short "What’s New" bullets for this release’s app store submission — one line per bullet, up to '+MOBILE_NOTE_MAX_LEN+' characters per language (the Google Play / App Store limit). Copy the formatted block below straight into the store listing form.</p>'+
      '<div class="field-row">'+
        '<div class="field">'+
          '<div class="mrn-col-head"><span class="mrn-col-label-group"><label for="mrn-en">English (en-US)</label><span class="mrn-counter" id="mrn-en-counter"></span></span>'+
            '<button type="button" class="btn btn-sm" data-action="draft-mobile-note-en">'+iconSpark()+' Draft from tickets</button>'+
          '</div>'+
          '<textarea id="mrn-en" rows="10" maxlength="'+MOBILE_NOTE_MAX_LEN+'" placeholder="Improved payment status guidance.\nVehicles sorted by license expiry.">'+esc(mrn.enUS||"")+'</textarea>'+
          '<div class="mrn-validation" id="mrn-en-validation" hidden></div>'+
        '</div>'+
        '<div class="field">'+
          '<div class="mrn-col-head"><span class="mrn-col-label-group"><label for="mrn-ar">Arabic (ar)</label><span class="mrn-counter" id="mrn-ar-counter"></span></span>'+
            '<button type="button" class="btn btn-sm" data-action="translate-mobile-note-ar">'+iconSpark()+' Translate from English</button>'+
          '</div>'+
          '<textarea id="mrn-ar" rows="10" maxlength="'+MOBILE_NOTE_MAX_LEN+'" dir="rtl" lang="ar" placeholder="تحسين عرض حالة الدفع في الطلبات.">'+esc(mrn.ar||"")+'</textarea>'+
          '<div class="mrn-validation" id="mrn-ar-validation" hidden></div>'+
        '</div>'+
      '</div>'+
      '<div class="notes-status" id="mobile-note-status"></div>'+
    '</div>'+
  '</section>';
}
function updateMobileNoteStatus(r){
  var el = qs("#mobile-note-status");
  if(!el) return;
  var mrn = r.mobileReleaseNote;
  var savedAt = mrn && mrn.savedAt ? fmtDateTime(mrn.savedAt) : null;
  var bits = [];
  if(state.mobileNoteDirty) bits.push('<span class="dirty-dot"></span> Unsaved changes');
  else if(savedAt) bits.push("Saved "+savedAt);
  else bits.push("Not saved yet");
  el.innerHTML = bits.join(" ");
}
// Live "n / 500" counter for each Mobile Release Note textarea — called on
// every render, on every keystroke (see the delegated "input" listener
// below), and after Draft/Translate replace a box's content programmatically
// (which bypasses the textarea's own maxlength enforcement, so this is also
// the only place that visibly flags an over-length AI/fallback result).
function updateMobileNoteCounters(){
  ["en","ar"].forEach(function(lang){
    var ta = qs("#mrn-"+lang);
    var counter = qs("#mrn-"+lang+"-counter");
    if(!ta || !counter) return;
    var len = ta.value.length;
    counter.textContent = len+" / "+MOBILE_NOTE_MAX_LEN;
    counter.classList.toggle("mrn-counter-warn", len >= Math.floor(MOBILE_NOTE_MAX_LEN*0.9) && len < MOBILE_NOTE_MAX_LEN);
    counter.classList.toggle("mrn-counter-max", len >= MOBILE_NOTE_MAX_LEN);
  });
}
// A persistent validation box under each Mobile Release Note textarea, for
// anything a Draft/Translate call needs the person to actually look at:
// a server-side warning (AI fell back to something simpler, Arabic text had
// to be stripped, some bullets got left out for length) or an outright
// failure (network/translation error). A toast (showToast) fires alongside
// these for a quick heads-up, but a toast fades in a few seconds — this box
// stays in the page (even across a Save — it's still true afterward that a
// ticket didn't make it in) until the next Draft/Translate re-evaluates it,
// so a warning about exactly *what* didn't make it into the draft can't be
// missed by arriving a moment too late to read it. `items`, if given, is a list of plain
// strings rendered one per line — e.g. "MOJ-42: Payment status guidance"
// for a ticket that got left out of the English draft, or the original
// English bullet text for one that didn't get translated — so the person
// knows exactly what to go add back by hand rather than just a count.
function showMobileNoteValidation(boxId, message, items, isError){
  var el = qs("#"+boxId);
  if(!el) return;
  if(!message && !(items && items.length)){ clearMobileNoteValidation(boxId); return; }
  var html = '<div class="mrn-validation-title">'+(isError? "⛔ ":"⚠️ ")+esc(message||"Some of this draft needs a look.")+'</div>';
  if(items && items.length){
    html += '<ul>'+items.map(function(it){ return '<li>'+esc(it)+'</li>'; }).join("")+'</ul>';
  }
  el.innerHTML = html;
  el.classList.toggle("mrn-validation-danger", !!isError);
  el.hidden = false;
}
function clearMobileNoteValidation(boxId){
  var el = qs("#"+boxId);
  if(!el) return;
  el.hidden = true;
  el.innerHTML = "";
  el.classList.remove("mrn-validation-danger");
}
// Splits a textarea's content into one trimmed, non-empty line per bullet —
// the client-side twin of mobileReleaseNoteLogic.linesToBullets on the
// server (see that file for why both exist: this one is used purely for
// formatting the copy-to-clipboard block, never sent over the wire as-is).
function mobileNoteLines(text){
  return String(text||"").split(/\n+/).map(function(l){return l.trim();}).filter(Boolean);
}
// The exact block format required by the store submission tooling — each
// locale's non-empty lines, bullet-prefixed, wrapped in its own tag.
function formatMobileReleaseNoteBlock(enUS, ar){
  var enLines = mobileNoteLines(enUS).map(function(l){ return /^[•\-*]\s*/.test(l) ? l.replace(/^[•\-*]\s*/, "• ") : "• "+l; });
  var arLines = mobileNoteLines(ar).map(function(l){ return /^[•\-*]\s*/.test(l) ? l.replace(/^[•\-*]\s*/, "• ") : "• "+l; });
  return "<en-US>\n"+enLines.join("\n")+"\n</en-US>\n<ar>\n"+arLines.join("\n")+"\n</ar>";
}

/* ---- Publish ---- */
function sectionPublish(r, assessment){
  var pub = r.published;
  var isPublished = !!(pub && pub.at);
  var body = isPublished
    ? '<div class="modal-success" style="margin:0;">Published '+esc(fmtDateTime(pub.at))+' — recommendation at the time: <strong>'+esc(pub.recommendation)+'</strong>. Publishing again will update this record with the current recommendation.</div>'
    : '<p class="helper-text">Once QA is happy with this release, publish it to record that it shipped. This snapshots the current AI recommendation for the record — it doesn’t lock the release, so you can keep editing afterward.</p>';
  return '<section class="card section-card" id="sec-publish">'+
    '<div class="section-head"><div class="section-title">🚀 Publish</div></div>'+
    '<div class="section-body">'+body+
      '<div style="margin-top:14px;"><button class="btn btn-primary" data-action="publish-release">🚀 Publish Release</button></div>'+
    '</div></section>';
}

/* ============================================================
   ICONS / SMALL UI HELPERS
   ============================================================ */
function pill(text, tone, extraClass){ return '<span class="pill '+(extraClass||"")+' tone-'+tone+'"><span class="pill-dot"></span>'+esc(text)+'</span>'; }
function iconPlus(){ return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'; }
function iconEdit(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'; }
function iconEye(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>'; }
function iconTrash(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>'; }
function iconCopy(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>'; }
function iconDots(){ return '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>'; }
function iconBack(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>'; }
function iconCalendar(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>'; }
function iconUser(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>'; }
function iconSpark(){ return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px;"><path d="M12 2l1.8 5.6L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.4L12 2z"/></svg>'; }
function iconSave(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>'; }
function iconLink(){ return '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>'; }
function iconJira(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12h8M12 8v8"/></svg>'; }
function iconRefresh(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>'; }
function iconClose(){ return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'; }
function iconNote(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'; }
function iconSearch(){ return '<svg class="search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>'; }
function iconGear(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'; }
function iconChevronUp(){ return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>'; }
function iconChevronDown(){ return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'; }
function iconDownload(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>'; }
function iconUpload(){ return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/></svg>'; }

/* ============================================================
   MODALS
   ============================================================ */
function openModal(innerHtml, opts){
  var root = qs("#modal-root");
  var sizeClass = opts && opts.xwide ? ' xwide' : (opts && opts.wide ? ' wide' : '');
  root.innerHTML = '<div class="modal-backdrop open" id="modal-backdrop"><div class="modal'+sizeClass+(opts&&opts.confirm?' confirm':'')+'">'+innerHtml+'</div></div>';
  qs("#modal-backdrop").addEventListener("mousedown", function(e){ if(e.target.id==="modal-backdrop") closeModal(); });
  var first = qs(".modal input, .modal select, .modal textarea", root);
  if(first) setTimeout(function(){ first.focus(); }, 20);
}
function closeModal(){ if(state.blockingModal) return; qs("#modal-root").innerHTML = ""; }
document.addEventListener("keydown", function(e){ if(e.key==="Escape" && !state.blockingModal) closeModal(); });

function statusChoiceGroup(name, options, current, plain){
  // plain=true skips the status-tone coloring — for non-status choices
  // (e.g. Jira auth type) where a PASS/FAIL-style color would be misleading.
  return '<div class="status-choice">'+options.map(function(o){
    var id = name+"-"+o.replace(/[^A-Za-z0-9]/g,"");
    var toneClass = plain ? "" : " tone-"+toneForStatus(o);
    return '<input type="radio" name="'+name+'" id="'+id+'" value="'+esc(o)+'" '+(o===current?"checked":"")+'><label for="'+id+'" class="'+toneClass.trim()+'">'+esc(o)+'</label>';
  }).join("")+'</div>';
}
// Same pill-list look as statusChoiceGroup above, but checkboxes — more
// than one can be checked at once — for a picker where several choices
// legitimately apply together, like a ticket's (possibly multi-person) QA
// Assignee. Shares the exact same .status-choice CSS: the `input:checked +
// label` selector styles a checked checkbox identically to a checked radio.
function multiChoiceGroup(name, options, selected){
  var sel = selected || [];
  return '<div class="status-choice">'+options.map(function(o){
    var id = name+"-"+o.replace(/[^A-Za-z0-9]/g,"");
    return '<input type="checkbox" name="'+name+'" id="'+id+'" value="'+esc(o)+'" '+(sel.indexOf(o)!==-1?"checked":"")+'><label for="'+id+'">'+esc(o)+'</label>';
  }).join("")+'</div>';
}
function modalShell(title, bodyHtml, footHtml, formId){
  return '<div class="modal-head"><h3>'+esc(title)+'</h3><button class="btn btn-icon btn-ghost" data-action="close-modal" aria-label="Close">'+iconClose()+'</button></div>'+
    '<form id="'+(formId||"modal-form")+'"><div class="modal-body">'+bodyHtml+'</div><div class="modal-foot">'+footHtml+'</div></form>';
}
function field(id,label,type,value){
  return '<div class="field"><label for="'+id+'">'+label+'</label><input type="'+type+'" id="'+id+'" value="'+escAttr(value)+'" '+(type==="number"?'min="0"':'')+'></div>';
}

/* ============================================================
   IDENTITY UI
   Sign-in is Atlassian-only (the server refuses to start without it) and
   proves who the person is; WHO THEY ARE ON THE QA TEAM comes from Know the
   Team — the one source of identities. A signed-in user pins "this Know the
   Team entry is me" once (the link is stored server-side, on the member's
   own record), and from then on every assignment, audit event and statistic
   references that member's stable id. There is no separate user list, no
   session, and nothing to type in.
   ============================================================ */
function renderTopbarUser(){
  var el = qs("#topbar-user");
  if(!el) return;
  var a = state.auth || {};
  if(!a.authenticated || !a.user){ el.innerHTML = ""; return; }
  var u = a.user;
  var me = currentMember();
  var avatarSrc = (me && me.photo) || u.avatarUrl;
  var avatar = avatarSrc ? '<img class="user-avatar" src="'+escAttr(avatarSrc)+'" alt="">' : iconUser();
  if(me){
    el.innerHTML =
      '<span class="user-badge" title="Signed in with Atlassian as '+escAttr(u.name)+' · your Know the Team entry">'+avatar+' '+esc(me.name)+'</span>'+
      '<button type="button" class="btn btn-ghost btn-sm" data-action="sign-out">Sign out</button>';
    return;
  }
  // Not linked to a Know the Team entry yet — assignments and audit entries
  // can't be tied to a team member until they are, so offer it right here
  // (non-blocking: everything else keeps working in the meantime).
  el.innerHTML =
    '<span class="user-badge" title="Signed in with Atlassian">'+avatar+' '+esc(u.name)+'</span>'+
    (state.teamReady && allTeamMembers().length
      ? '<button type="button" class="btn btn-sm" data-action="link-identity" title="Pick your Know the Team entry so your work is attributed to you">'+iconUser()+' Link to team</button>'
      : '')+
    '<button type="button" class="btn btn-ghost btn-sm" data-action="sign-out">Sign out</button>';
}
function openSignInModal(){
  state.blockingModal = true;
  var root = qs("#modal-root");
  root.innerHTML =
    '<div class="modal-backdrop open" id="modal-backdrop"><div class="modal">'+
      '<div class="modal-head"><h3>Sign in to Greenlight</h3></div>'+
      '<div class="modal-body">'+
        '<p class="helper-text" style="margin:0;">This deployment requires signing in with your company Atlassian account. Only people with access to this Jira site can use Greenlight. Your activity is attributed to your entry in Know the Team.</p>'+
      '</div>'+
      '<div class="modal-foot"><a class="btn btn-primary" href="/auth/login" style="flex:1;justify-content:center;">'+iconJira()+' Sign in with Atlassian</a></div>'+
    '</div></div>';
}
// "Which Know the Team entry is you?" — a plain pick-list over the one
// roster (no typing, no new accounts). Pre-selects the entry whose name
// matches the signed-in Atlassian name, when there is one. Saving writes the
// same server-side link as the "This is me" item on a team card.
function openLinkIdentityModal(){
  var members = allTeamMembers();
  if(!members.length){ showToast("Add yourself in Know the Team first."); return; }
  var linkedId = myLinkedTeamMemberId();
  var suggestion = suggestedMyTeamMember();
  var current = linkedId || (suggestion && suggestion.id) || "";
  var body =
    '<p class="helper-text" style="margin:0 0 10px;">Pick your entry in <b>Know the Team</b>. Tickets and regression assigned to you, your audit trail and your statistics all follow this one choice.</p>'+
    memberChoiceGroup("link-identity-choice", members, current);
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Save</button>';
  openModal(modalShell("Who are you?", body, foot));
  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    var checked = qs('input[name="link-identity-choice"]:checked');
    if(!checked){ showToast("Pick your name from the list."); return; }
    closeModal();
    setMyLinkedTeamMember(checked.value, true);
  });
}

/* ---- Create / edit release ---- */
function openCreateReleaseModal(){
  var body =
    '<div class="field"><label for="f-name">Release Name</label><input type="text" id="f-name" placeholder="e.g. Spring Platform Update" required></div>'+
    '<div class="field-row">'+
      '<div class="field"><label for="f-version">Version</label><input type="text" id="f-version" placeholder="e.g. 2.5.0"></div>'+
      '<div class="field"><label for="f-date">Release Date</label><input type="date" id="f-date"></div>'+
    '</div>'+
    '<div class="field"><label for="f-owner">QA Owner</label><input type="text" id="f-owner" placeholder="e.g. Layla Haddad"></div>'+
    '<p class="helper-text">Version is also used to match Jira’s Fix Version when syncing tickets.</p>';
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Create release</button>';
  openModal(modalShell("Create release", body, foot));
  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    var name = qs("#f-name").value.trim();
    if(!name){ qs("#f-name").focus(); return; }
    api.createRelease({name:name, version:qs("#f-version").value.trim(), date:qs("#f-date").value, qaOwner:qs("#f-owner").value.trim()})
      .then(function(r){
        state.releases[r._id]=r;
        closeModal();
        logAudit({action:"RELEASE_CREATED", entityType:"Release", entityId:r._id, details: releaseLabel(r)});
        goTo("#/r/"+r._id);
      })
      .catch(function(e){ showToast(e.message); });
  });
}
function openEditReleaseInfoModal(r){
  var body =
    '<div class="field"><label for="f-name">Release Name</label><input type="text" id="f-name" value="'+escAttr(r.name)+'" required></div>'+
    '<div class="field-row">'+
      '<div class="field"><label for="f-version">Version</label><input type="text" id="f-version" value="'+escAttr(r.version)+'"></div>'+
      '<div class="field"><label for="f-date">Release Date</label><input type="date" id="f-date" value="'+escAttr(r.date)+'"></div>'+
    '</div>'+
    '<div class="field"><label for="f-owner">QA Owner</label><input type="text" id="f-owner" value="'+escAttr(r.qaOwner)+'"></div>'+
    '<div class="field"><label for="f-highlights">Release Highlights <span class="hint">(optional — one per line, powers "What’s New" in release notes)</span></label>'+
      '<textarea id="f-highlights" rows="4">'+esc(r.highlights||"")+'</textarea></div>'+
    '<p class="helper-text">Version is also used as the Jira Fix Version match when syncing tickets.</p>';
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Save changes</button>';
  openModal(modalShell("Edit release info", body, foot));
  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    var name = qs("#f-name").value.trim();
    if(!name){ qs("#f-name").focus(); return; }
    r.name=name; r.version=qs("#f-version").value.trim(); r.date=qs("#f-date").value;
    r.qaOwner=qs("#f-owner").value.trim(); r.highlights=qs("#f-highlights").value;
    closeModal();
    persistRelease(r, function(){
      logAudit({action:"RELEASE_UPDATED", entityType:"Release", entityId:r._id, details: releaseLabel(r)});
    });
  });
}

// onSuccess (optional) only runs after the save actually succeeds — used by
// call-sites that need to log an audit event, so a failed save is never
// recorded as if it happened. Existing callers that don't pass it are
// unaffected.
function persistRelease(r, onSuccess){
  return api.saveRelease(r._id, r).then(function(updated){
    state.releases[r._id]=updated;
    render();
    if(onSuccess) onSuccess();
  }).catch(function(e){ showToast(e.message); });
}

/* ---- Tickets: Add / Edit ---- */
function openAddTicketModal(r){
  var js = state.jiraStatus || {connected:false};
  var manualFields = js.connected ? "" :
    '<div class="field"><label for="f-title">Title</label><input type="text" id="f-title" placeholder="Ticket summary"></div>'+
    '<div class="field-row">'+
      '<div class="field"><label for="f-status">Status</label><select id="f-status">'+TICKET_STATUS_OPTIONS.map(function(s){return '<option value="'+s+'">'+s+'</option>';}).join("")+'</select></div>'+
      '<div class="field"><label for="f-type">Issue Type</label><input type="text" id="f-type" placeholder="e.g. Bug, Story, Task"></div>'+
    '</div>'+
    '<div class="field"><label for="f-priority">Priority</label><input type="text" id="f-priority" placeholder="e.g. High" list="priority-options"><datalist id="priority-options"><option value="Highest"><option value="High"><option value="Medium"><option value="Low"><option value="Lowest"></datalist></div>';
  var body =
    '<div class="field"><label for="f-url">Jira Ticket URL</label><input type="url" id="f-url" placeholder="https://jira.example.com/browse/MOJ-1234" required></div>'+
    (js.connected ? '<p class="helper-text">Jira is connected — title, status, issue type and priority will be pulled in automatically.</p>' : '<p class="helper-text">Jira isn’t connected, so fill these in yourself.</p>')+
    manualFields+
    '<div id="add-ticket-error"></div>';
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Add ticket</button>';
  openModal(modalShell("Add Ticket", body, foot));
  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    var url = qs("#f-url").value.trim();
    if(!url){ qs("#f-url").focus(); return; }
    var payload = {url:url};
    if(!js.connected){
      payload.title = qs("#f-title") ? qs("#f-title").value.trim() : "";
      payload.status = qs("#f-status") ? qs("#f-status").value : "";
      payload.issueType = qs("#f-type") ? qs("#f-type").value.trim() : "";
      payload.priority = qs("#f-priority") ? qs("#f-priority").value.trim() : "";
    }
    var submitBtn = qs('.modal button[type=submit]');
    submitBtn.disabled = true; submitBtn.textContent = "Adding…";
    api.addTicket(r._id, payload).then(function(result){
      if(result.duplicate){
        closeModal();
        showToast(result.ticket.key+" is already in this release");
        return;
      }
      state.releases[r._id] = result.release;
      closeModal();
      if(result.lookupError){
        showToast("Added "+result.ticket.key+", but couldn’t fetch details from Jira — edit it to fill fields in manually.");
      } else {
        showToast("Added "+result.ticket.key);
      }
      logAudit({action:"TICKET_ADDED", entityType:"Ticket", entityId: result.ticket.key, details: result.ticket.title || "Untitled"});
      render();
    }).catch(function(e){
      qs("#add-ticket-error").innerHTML = '<div class="modal-error" style="margin-top:6px;">'+esc(e.message)+'</div>';
      submitBtn.disabled = false; submitBtn.textContent = "Add ticket";
    });
  });
}
function openEditTicketModal(r, ticket){
  var body =
    '<div class="field"><label>Key</label><input type="text" value="'+escAttr(ticket.key)+'" disabled></div>'+
    '<div class="field"><label for="f-title">Title</label><input type="text" id="f-title" value="'+escAttr(ticket.title)+'"></div>'+
    '<div class="field-row">'+
      '<div class="field"><label for="f-status">Status</label><input type="text" id="f-status" value="'+escAttr(ticket.status)+'"></div>'+
      '<div class="field"><label for="f-bucket">Bucket</label><select id="f-bucket">'+TICKET_BUCKETS.map(function(b){return '<option value="'+b+'" '+(b===ticket.bucket?"selected":"")+'>'+b+'</option>';}).join("")+'</select></div>'+
    '</div>'+
    '<div class="field-row">'+
      '<div class="field"><label for="f-type">Issue Type</label><input type="text" id="f-type" value="'+escAttr(ticket.issueType)+'"></div>'+
      '<div class="field"><label for="f-priority">Priority</label><input type="text" id="f-priority" value="'+escAttr(ticket.priority)+'"></div>'+
    '</div>'+
    '<div class="field"><label for="f-url">Jira URL</label><input type="url" id="f-url" value="'+escAttr(ticket.url)+'"></div>';
  var foot = '<button type="button" class="btn btn-danger" id="del-ticket">'+iconTrash()+' Remove</button><span style="flex:1"></span><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Save changes</button>';
  openModal(modalShell("Edit ticket — "+ticket.key, body, foot));
  qs("#del-ticket").addEventListener("click", function(){
    r.tickets = r.tickets.filter(function(t){return t.key!==ticket.key;});
    closeModal();
    persistRelease(r);
  });
  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    ticket.title = qs("#f-title").value.trim();
    ticket.status = qs("#f-status").value.trim();
    ticket.bucket = qs("#f-bucket").value;
    ticket.issueType = qs("#f-type").value.trim();
    ticket.priority = qs("#f-priority").value.trim();
    ticket.url = qs("#f-url").value.trim();
    ticket.updatedAt = new Date().toISOString();
    closeModal();
    persistRelease(r, function(){
      logAudit({action:"TICKET_UPDATED", entityType:"Ticket", entityId: ticket.key, details: ticket.title || "Untitled"});
    });
  });
}

// QA owner for one ticket — a pick-list of Know the Team members (one person,
// stored as that member's id) plus Unassigned. "Use Jira's assignee" (shown
// only while there's a manual choice) removes the manual choice so the ticket
// goes back to following Jira's QA Assigned field. The assignment audit
// event (assigned / reassigned / unassigned, with the previous and new
// member) is written by the server when the release is saved.
// Check-box pills of Know the Team members, each carrying the member's ID as
// its value (the label is the name) — several can be ticked.
function memberMultiChoiceGroup(name, members, selectedIds){
  var sel = selectedIds || [];
  return '<div class="status-choice">'+members.map(function(m, i){
    var id = name+"-"+i;
    return '<input type="checkbox" name="'+name+'" id="'+id+'" value="'+escAttr(m.id)+'" '+(sel.indexOf(m.id)!==-1?"checked":"")+'><label for="'+id+'">'+esc(m.name)+'</label>';
  }).join("")+'</div>';
}
// QA owners for one ticket — a checkbox pill-list of Know the Team members
// ("QA Assigned" is a multi-person Jira field: a ticket can genuinely have
// more than one owner). Stored as member ids: one id, or an array of ids when
// several are ticked, [] -> null for nobody. "Use Jira's assignees" (shown
// only while there's a manual choice) removes the manual choice so the ticket
// goes back to following Jira's QA Assigned field. A manual choice always
// wins over Jira — a re-sync only refreshes qaAssignedFromJira. The assignment
// audit event is written by the server when the release is saved.
function openTicketAssigneeModal(r, ticket){
  var members = ticketAssigneeOptions();
  var hasOverride = ticketHasManualAssignee(ticket);
  var jiraNames = ticketJiraNames(ticket);
  var entries = ticketAssigneeEntries(ticket);
  var current = ticketAssignedMemberIds(ticket);
  var outsiders = entries.filter(function(e){ return !e.id; }).map(function(e){ return e.label; });
  var subtitle = hasOverride
    ? (jiraNames.length ? "Jira's own QA Assigned field currently lists "+jiraNames.join(", ")+". Your manual choice below overrides it until you revert to Jira's assignees."
                        : "This has a manual choice — Jira's QA Assigned field has no one set for this ticket right now.")
    : (jiraNames.length ? "Currently synced from Jira's QA Assigned field ("+jiraNames.join(", ")+"). Checking names below overrides it just for this ticket."
                        : "Jira's QA Assigned field has no one set for this ticket yet — check anyone below, or leave it to pick up a value from Jira later.");
  var body =
    '<div class="regmod-edit-name">'+esc(ticket.key)+' — '+esc(ticket.title||"Untitled")+'</div>'+
    '<p class="helper-text" style="margin:2px 0 10px;">'+esc(subtitle)+'</p>'+
    (members.length
      ? memberMultiChoiceGroup("ticket-assignee-check", members, current)+'<p class="hint" style="margin-top:8px;">Check as many as apply — leave all unchecked for Unassigned.'+
        (outsiders.length ? ' '+esc(outsiders.join(", "))+(outsiders.length>1?' aren’t':' isn’t')+' in Know the Team, so can’t be ticked here (add '+(outsiders.length>1?'them':'them')+' there, or put the spelling Jira uses in their “Jira name(s)”).' : '')+'</p>'
      : '<p class="helper-text" style="margin:0;">No one is in <b>Know the Team</b> yet — add people there first.</p>');
  var foot = (hasOverride ? '<button type="button" class="btn btn-ghost" id="ticket-assignee-use-jira">Use Jira’s assignees</button>' : '<span></span>')+
    '<span style="flex:1"></span><button type="button" class="btn" data-action="close-modal">Cancel</button>'+
    (members.length ? '<button type="submit" class="btn btn-primary">Save</button>' : '');
  openModal(modalShell("Assign QA owners", body, foot));

  var useJiraBtn = qs("#ticket-assignee-use-jira");
  if(useJiraBtn) useJiraBtn.addEventListener("click", function(){
    delete ticket.assignedTo;
    delete ticket.legacyQaAssignee;
    ticket.updatedAt = new Date().toISOString();
    closeModal();
    persistRelease(r);
  });

  if(!members.length) return; // nothing to check, and no Save button to wire up
  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    var picked = qsa('input[name="ticket-assignee-check"]:checked').map(function(el){ return el.value; });
    var same = picked.length===current.length && picked.every(function(id){ return current.indexOf(id)!==-1; });
    if(same && !outsiders.length && (hasOverride || !picked.length)){ closeModal(); return; } // nothing changed
    // presence of the key marks this manual, even when nobody is picked
    ticket.assignedTo = picked.length===0 ? null : picked.length===1 ? picked[0] : picked;
    delete ticket.legacyQaAssignee; // resolved by this choice
    ticket.updatedAt = new Date().toISOString();
    closeModal();
    persistRelease(r, function(){
      var names = picked.map(memberNameById).join(", ");
      showToast(picked.length ? "✓ "+ticket.key+" assigned to "+names : "✓ "+ticket.key+" unassigned");
    });
  });
}

/* ---- Regression / Bug / Platform / Blocker / Perf / Security modals ---- */
// Entities and Services themselves come from the reusable master list (see
// openManageRegressionModulesModal). Per release, status is set inline via
// the row's status buttons (see regressionStatusButtons / the
// "set-regression-status" change handler) — this modal only edits Notes.
function openRegressionNotesModal(r, entity, existing){
  if(!existing) return;
  var isLegacy = !!entity._legacy;
  var body =
    '<div class="regmod-edit-name">'+esc(entity.name||"Unnamed entity")+(isLegacy? "" : " — "+esc(existing.name||"Unnamed service"))+'</div>'+
    '<div class="field"><label for="f-notes">Notes</label><textarea id="f-notes" rows="4" placeholder="Add a note about this service’s regression result…">'+esc(existing.notes||"")+'</textarea></div>';
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Save note</button>';
  openModal(modalShell("Regression notes", body, foot));
  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    var notes = qs("#f-notes").value.trim();
    // For a legacy (pre-Entities/Services) row, `existing` is a disconnected
    // display copy — write through to the real object so the save sticks.
    var target = isLegacy ? entity._legacy : existing;
    target.notes = notes;
    closeModal();
    var regLabel = (entity.name||"Unnamed entity")+(isLegacy? "" : " — "+(existing.name||"Unnamed service"));
    persistRelease(r, function(){
      logAudit({action:"REGRESSION_UPDATED", entityType:"Regression", entityId: existing.id || entity.id, details: "Updated notes — "+regLabel});
    });
  });
}

// Notes for an entity's own "Overall status" (used only when the entity has
// no services — see renderRegressionEntityGroup/regressionEntityStatusButtons).
// `entity` here is always the real release.regression row (regressionEntities()
// returns it directly, not a copy, for anything that isn't a legacy flat
// row — and a 0-service entity can never be legacy, see regressionEntities),
// so writing straight to entity.notes is safe.
function openRegressionEntityNotesModal(r, entity){
  var body =
    '<div class="regmod-edit-name">'+esc(entity.name||"Unnamed entity")+'</div>'+
    '<div class="field"><label for="f-notes">Notes</label><textarea id="f-notes" rows="4" placeholder="Add a note about this page’s regression result…">'+esc(entity.notes||"")+'</textarea></div>';
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Save note</button>';
  openModal(modalShell("Regression notes", body, foot));
  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    entity.notes = qs("#f-notes").value.trim();
    closeModal();
    persistRelease(r, function(){
      logAudit({action:"REGRESSION_UPDATED", entityType:"Regression", entityId: entity.id, details: "Updated notes — "+(entity.name||"Unnamed entity")});
    });
  });
}

// Entity-level "who's covering this". Reuses the same pill-radio list the
// other pickers use (values are Know the Team member IDS, labels are names),
// so assigning someone never means typing a name or adding a new "assignee"
// concept. Every module under the entity follows this owner unless it has an
// owner of its own — which this never overwrites. The assigned / unassigned
// audit event is written by the server when the release is saved.
//
// The write target has to account for a legacy (pre-Entities/Services) row:
// regressionEntities() wraps one of those as a synthetic single-service
// entity, and entity._legacy is the real underlying row in that case.
function openRegressionAssignModal(r, entity){
  var members = regressionOwnerOptions();
  var current = entity.assignedTo || "";
  var title = entity.name||"Unnamed entity";
  var hasServices = (entity.services||[]).length>0 && !entity._legacy;
  var subtitle = hasServices
    ? "Sets the owner for every module in this entity that doesn't have its own owner."
    : "Sets who covers this entity's regression.";
  var legacyNote = !current && entity.legacyOwner
    ? '<p class="helper-text" style="margin:0 0 10px;">Previously assigned to “'+esc(entity.legacyOwner)+'”, who isn’t in Know the Team — pick a team member to replace it.</p>' : '';
  var body =
    '<div class="regmod-edit-name">'+esc(title)+'</div>'+
    '<p class="helper-text" style="margin:2px 0 10px;">'+esc(subtitle)+'</p>'+legacyNote+
    (members.length ? "" : '<p class="helper-text" style="margin:0 0 10px;">No one is available in <b>Know the Team</b> yet — add people there first, or choose Unassigned below.</p>')+
    memberChoiceGroup("reg-owner-choice", members, current, [{value:"", label:"Unassigned", after:true}]);
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Assign</button>';
  openModal(modalShell("Assign Entity regression", body, foot));
  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    var checked = qs('input[name="reg-owner-choice"]:checked');
    var picked = checked ? checked.value : current;
    if(picked===current){ closeModal(); return; }
    var target = entity._legacy || entity;
    target.assignedTo = picked || null;
    delete target.legacyOwner;
    closeModal();
    persistRelease(r, function(){
      showToast(picked ? "✓ "+title+" assigned to "+memberNameById(picked) : "✓ "+title+" unassigned");
    });
  });
}

// One module's own assignee: a specific team member, Unassigned (deliberately
// nobody, even if the entity has an owner), or "Use Entity owner" — which
// removes the module's own choice so it follows the Entity again.
var REG_USE_ENTITY_OWNER = "__entity__";
function openRegressionModuleAssignModal(r, entity, service){
  var members = regressionOwnerOptions();
  var hasOverride = regressionModuleHasOverride(service);
  var current = hasOverride ? (service.assignedTo || "") : REG_USE_ENTITY_OWNER;
  var entityOwner = entity.assignedTo ? memberNameById(entity.assignedTo) : "no one";
  var body =
    '<div class="regmod-edit-name">'+esc(entity.name||"Unnamed entity")+' — '+esc(service.name||"Unnamed module")+'</div>'+
    '<p class="helper-text" style="margin:2px 0 10px;">An owner picked here takes precedence over the Entity owner for this module only.</p>'+
    memberChoiceGroup("reg-module-owner-choice", members, current, [
      {value:REG_USE_ENTITY_OWNER, label:"Use Entity owner ("+entityOwner+")"},
      {value:"", label:"Unassigned", after:true}
    ]);
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Assign</button>';
  openModal(modalShell("Assign module regression", body, foot));
  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    var checked = qs('input[name="reg-module-owner-choice"]:checked');
    var picked = checked ? checked.value : current;
    if(picked===current){ closeModal(); return; }
    if(picked===REG_USE_ENTITY_OWNER) delete service.assignedTo;
    else service.assignedTo = picked || null;
    closeModal();
    var label = (entity.name||"Unnamed entity")+" — "+(service.name||"Unnamed module");
    persistRelease(r, function(){
      showToast(picked===REG_USE_ENTITY_OWNER ? "✓ "+label+" now follows the Entity owner"
        : picked ? "✓ "+label+" assigned to "+memberNameById(picked) : "✓ "+label+" unassigned");
    });
  });
}

// "Assign Regression" — the bulk workflow: assign whole Entities AND/OR
// individual modules to team members in one save, from a table of <select>s.
// A module row's first choice is "Use Entity owner" (its default), so picking
// an Entity owner moves every module that follows it and never overwrites a
// module that was given its own owner. Only rows that actually changed are
// written (picking what a row already had is a no-op), and the server turns
// the saved differences into the assignment audit events.
function openBulkAssignRegressionModal(r){
  var entities = regressionEntities(r);
  if(!entities.length){ showToast("No regression modules on this release yet."); return; }
  var members = regressionOwnerOptions();

  var body =
    (members.length ? '' : '<p class="helper-text">No one is available in <b>Know the Team</b> yet — add people there first to assign, or use Unassigned below.</p>')+
    '<div id="bulk-assign-rows"></div>';
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">'+iconSave()+' Save</button>';
  openModal(modalShell("Assign Regression", body, foot), {wide:true});
  var rowsEl = qs("#bulk-assign-rows");

  function optionsHtml(currentVal, extras){
    var opts = [];
    (extras||[]).forEach(function(x){ opts.push('<option value="'+escAttr(x.value)+'"'+(currentVal===x.value?" selected":"")+'>'+esc(x.label)+'</option>'); });
    members.forEach(function(m){ opts.push('<option value="'+escAttr(m.id)+'"'+(currentVal===m.id?" selected":"")+'>'+esc(m.name)+'</option>'); });
    return opts.join("");
  }
  rowsEl.innerHTML = '<div class="bulk-assign-table">'+entities.map(function(ent){
    var cur = ent.assignedTo || "";
    var entityRow = '<div class="bulk-assign-row bulk-assign-entity"><div class="bulk-assign-label">'+esc(ent.name||"Unnamed entity")+'</div>'+
      '<select class="bulk-assign-select" data-entity-id="'+escAttr(ent.id)+'" data-kind="entity">'+optionsHtml(cur, [{value:"", label:"Unassigned"}])+'</select></div>';
    var moduleRows = ent._legacy ? "" : (ent.services||[]).map(function(sv){
      var curM = regressionModuleHasOverride(sv) ? (sv.assignedTo || "") : REG_USE_ENTITY_OWNER;
      return '<div class="bulk-assign-row bulk-assign-module"><div class="bulk-assign-label">'+esc(sv.name||"Unnamed module")+'</div>'+
        '<select class="bulk-assign-select" data-entity-id="'+escAttr(ent.id)+'" data-service-id="'+escAttr(sv.id)+'" data-kind="module">'+
          optionsHtml(curM, [{value:REG_USE_ENTITY_OWNER, label:"Use Entity owner"}, {value:"", label:"Unassigned"}])+'</select></div>';
    }).join("");
    return entityRow+moduleRows;
  }).join("")+'</div>';

  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    var changed = 0;
    qsa(".bulk-assign-select", rowsEl).forEach(function(sel){
      var val = sel.value;
      var ent = entities.find(function(x){return x.id===sel.getAttribute("data-entity-id");});
      if(!ent) return;
      if(sel.getAttribute("data-kind")==="entity"){
        if(val===(ent.assignedTo||"")) return;
        var target = ent._legacy || ent;
        target.assignedTo = val || null;
        delete target.legacyOwner;
        changed++;
        return;
      }
      var sv = (ent.services||[]).find(function(x){return x.id===sel.getAttribute("data-service-id");});
      if(!sv) return;
      var curM = regressionModuleHasOverride(sv) ? (sv.assignedTo || "") : REG_USE_ENTITY_OWNER;
      if(val===curM) return;
      if(val===REG_USE_ENTITY_OWNER) delete sv.assignedTo;
      else sv.assignedTo = val || null;
      changed++;
    });
    closeModal();
    if(!changed) return;
    persistRelease(r, function(){
      showToast("✓ Updated "+changed+" assignment"+pluralize(changed,"","s"));
    });
  });
}

/* ---- Manage Regression Modules (the reusable master list: Entity -> Services) ---- */
function openManageRegressionModulesModal(){
  var body =
    '<p class="helper-text">This list auto-fills the Regression section for every new release, grouped by Entity → Services. Changes here never affect a release that already exists.</p>'+
    '<div id="regmod-list" class="regmod-entity-list">'+'<div class="empty-row">Loading…</div>'+'</div>'+
    '<div class="field-row" style="align-items:flex-end;">'+
      '<div class="field" style="margin:0;"><label for="regmod-new-entity-name">New entity</label><input type="text" id="regmod-new-entity-name" placeholder="e.g. New Ministry"></div>'+
      '<button type="button" class="btn" id="regmod-add-entity-btn" style="align-self:flex-end;">'+iconPlus()+' Add Entity</button>'+
    '</div>';
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button>'+
    '<button type="button" class="btn btn-primary" id="regmod-save-btn" disabled>'+iconSave()+' Save Regression Modules</button>';
  openModal(modalShell("Manage Regression Modules", body, foot), {wide:true});
  // This modal manages its own local state and saves explicitly via a
  // plain button — neutralize the wrapping form's implicit submit so
  // Enter in any of its text fields can't trigger it unexpectedly.
  qs("#modal-form").addEventListener("submit", function(e){ e.preventDefault(); });

  var working = null; // local editable copy: [{id, name, services:[{id,name}]}], only persisted on Save
  var listEl = qs("#regmod-list");
  var saveBtn = qs("#regmod-save-btn");

  function renderRows(){
    listEl.innerHTML = working.length ? working.map(function(ent, ei){
      var svcRows = (ent.services||[]).map(function(s, si){
        return '<div class="regmod-service-row">'+
          '<div class="regmod-reorder">'+
            '<button type="button" class="btn btn-sm btn-icon" data-svc-action="up" data-entity-idx="'+ei+'" data-svc-idx="'+si+'" '+(si===0?"disabled":"")+' aria-label="Move service up">'+iconChevronUp()+'</button>'+
            '<button type="button" class="btn btn-sm btn-icon" data-svc-action="down" data-entity-idx="'+ei+'" data-svc-idx="'+si+'" '+(si===ent.services.length-1?"disabled":"")+' aria-label="Move service down">'+iconChevronDown()+'</button>'+
          '</div>'+
          '<div class="field" style="margin:0;flex:1;"><input type="text" class="regmod-service-name-input" data-entity-idx="'+ei+'" data-svc-idx="'+si+'" value="'+escAttr(s.name)+'"></div>'+
          '<button type="button" class="btn btn-sm btn-icon btn-danger" data-svc-action="delete" data-entity-idx="'+ei+'" data-svc-idx="'+si+'" aria-label="Delete service">'+iconTrash()+'</button>'+
        '</div>';
      }).join("");
      return '<div class="regmod-entity-card">'+
        '<div class="regmod-entity-head">'+
          '<div class="regmod-reorder">'+
            '<button type="button" class="btn btn-sm btn-icon" data-ent-action="up" data-entity-idx="'+ei+'" '+(ei===0?"disabled":"")+' aria-label="Move entity up">'+iconChevronUp()+'</button>'+
            '<button type="button" class="btn btn-sm btn-icon" data-ent-action="down" data-entity-idx="'+ei+'" '+(ei===working.length-1?"disabled":"")+' aria-label="Move entity down">'+iconChevronDown()+'</button>'+
          '</div>'+
          '<div class="field" style="margin:0;flex:1;"><input type="text" class="regmod-entity-name-input" data-entity-idx="'+ei+'" value="'+escAttr(ent.name)+'" placeholder="Entity name"></div>'+
          '<button type="button" class="btn btn-sm btn-icon btn-danger" data-ent-action="delete" data-entity-idx="'+ei+'" aria-label="Delete entity">'+iconTrash()+'</button>'+
        '</div>'+
        (svcRows ? '<div class="regmod-service-list">'+svcRows+'</div>' : '<div class="empty-row" style="padding:12px;">No services yet.</div>')+
        '<div class="regmod-add-service-row">'+
          '<div class="field" style="margin:0;flex:1;"><input type="text" class="regmod-new-service-input" data-entity-idx="'+ei+'" placeholder="Add a service…"></div>'+
          '<button type="button" class="btn btn-sm regmod-add-service-btn" data-entity-idx="'+ei+'">'+iconPlus()+' Add service</button>'+
        '</div>'+
      '</div>';
    }).join("") : '<div class="empty-row">No entities yet. Add your first one below.</div>';
  }

  api.listRegressionModules().then(function(list){
    working = list.map(function(ent){
      return { id:ent.id, name:ent.name, services:(ent.services||[]).map(function(s){ return {id:s.id, name:s.name}; }) };
    });
    renderRows();
    saveBtn.disabled = false;
  }).catch(function(e){
    listEl.innerHTML = '<div class="modal-error">'+esc(e.message)+'</div>';
  });

  function addServiceTo(ei){
    if(!working || !working[ei]) return;
    var input = listEl.querySelector('.regmod-new-service-input[data-entity-idx="'+ei+'"]');
    var name = input ? input.value.trim() : "";
    if(!name){ if(input) input.focus(); return; }
    working[ei].services = working[ei].services||[];
    working[ei].services.push({id: crypto.randomUUID(), name: name});
    renderRows();
    var again = listEl.querySelector('.regmod-new-service-input[data-entity-idx="'+ei+'"]');
    if(again) again.focus();
  }

  listEl.addEventListener("click", function(e){
    if(!working) return;
    var entBtn = e.target.closest("[data-ent-action]");
    var svcBtn = e.target.closest("[data-svc-action]");
    var addSvcBtn = e.target.closest(".regmod-add-service-btn");
    if(entBtn){
      var ei = parseInt(entBtn.getAttribute("data-entity-idx"), 10);
      var act = entBtn.getAttribute("data-ent-action");
      if(act==="delete"){ working.splice(ei,1); renderRows(); }
      else if(act==="up" && ei>0){ var t1=working[ei-1]; working[ei-1]=working[ei]; working[ei]=t1; renderRows(); }
      else if(act==="down" && ei<working.length-1){ var t2=working[ei+1]; working[ei+1]=working[ei]; working[ei]=t2; renderRows(); }
      return;
    }
    if(svcBtn){
      var ei2 = parseInt(svcBtn.getAttribute("data-entity-idx"), 10);
      var si = parseInt(svcBtn.getAttribute("data-svc-idx"), 10);
      var act2 = svcBtn.getAttribute("data-svc-action");
      var ent = working[ei2];
      if(!ent) return;
      ent.services = ent.services||[];
      if(act2==="delete"){ ent.services.splice(si,1); renderRows(); }
      else if(act2==="up" && si>0){ var s1=ent.services[si-1]; ent.services[si-1]=ent.services[si]; ent.services[si]=s1; renderRows(); }
      else if(act2==="down" && si<ent.services.length-1){ var s2=ent.services[si+1]; ent.services[si+1]=ent.services[si]; ent.services[si]=s2; renderRows(); }
      return;
    }
    if(addSvcBtn){
      addServiceTo(parseInt(addSvcBtn.getAttribute("data-entity-idx"), 10));
    }
  });
  listEl.addEventListener("input", function(e){
    if(!working) return;
    if(e.target.matches(".regmod-entity-name-input")){
      var ei = parseInt(e.target.getAttribute("data-entity-idx"), 10);
      if(working[ei]) working[ei].name = e.target.value;
    } else if(e.target.matches(".regmod-service-name-input")){
      var ei2 = parseInt(e.target.getAttribute("data-entity-idx"), 10);
      var si = parseInt(e.target.getAttribute("data-svc-idx"), 10);
      if(working[ei2] && working[ei2].services[si]) working[ei2].services[si].name = e.target.value;
    }
  });
  listEl.addEventListener("keydown", function(e){
    if(e.key==="Enter" && e.target.matches(".regmod-new-service-input")){
      e.preventDefault();
      addServiceTo(parseInt(e.target.getAttribute("data-entity-idx"), 10));
    }
  });

  function addEntity(){
    if(!working) return;
    var input = qs("#regmod-new-entity-name");
    var name = input.value.trim();
    if(!name){ input.focus(); return; }
    working.push({id: crypto.randomUUID(), name: name, services: []});
    input.value = "";
    renderRows();
    input.focus();
  }
  qs("#regmod-add-entity-btn").addEventListener("click", addEntity);
  qs("#regmod-new-entity-name").addEventListener("keydown", function(e){
    if(e.key==="Enter"){ e.preventDefault(); addEntity(); }
  });

  saveBtn.addEventListener("click", function(){
    if(!working) return;
    var cleaned = working.map(function(ent){
      return {
        id: ent.id,
        name: (ent.name||"").trim(),
        services: (ent.services||[]).map(function(s){ return {id:s.id, name:(s.name||"").trim()}; }).filter(function(s){ return s.name; })
      };
    }).filter(function(ent){ return ent.name; });
    saveBtn.disabled = true; saveBtn.innerHTML = "Saving…";
    api.saveRegressionModules(cleaned).then(function(){
      closeModal();
      showToast("Regression modules saved");
    }).catch(function(e){
      showToast(e.message);
      saveBtn.disabled = false; saveBtn.innerHTML = iconSave()+' Save Regression Modules';
    });
  });
}
function openBugModal(r, existing){
  var b = existing || {bugId:"", title:"", severity:"Medium", status:"Open", notes:""};
  var body =
    '<div class="field-row">'+
      '<div class="field"><label for="f-bugid">Bug ID <span class="hint">(optional)</span></label><input type="text" id="f-bugid" value="'+escAttr(b.bugId)+'" placeholder="e.g. PAY-482"></div>'+
      '<div class="field"><label for="f-title">Bug Title</label><input type="text" id="f-title" value="'+escAttr(b.title)+'" required placeholder="Short description"></div>'+
    '</div>'+
    '<div class="field"><label>Severity</label>'+statusChoiceGroup("severity", BUG_SEVERITIES, b.severity)+'</div>'+
    '<div class="field"><label>Status</label>'+statusChoiceGroup("bstatus", BUG_STATUSES, b.status)+'</div>'+
    '<div class="field"><label for="f-notes">Notes <span class="hint">(optional)</span></label><textarea id="f-notes" rows="3">'+esc(b.notes||"")+'</textarea></div>';
  var foot = (existing? '<button type="button" class="btn btn-danger" id="del-bug">'+iconTrash()+' Delete</button>' : '<span></span>')+
    '<span style="flex:1"></span><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">'+(existing?"Save changes":"Add bug")+'</button>';
  openModal(modalShell(existing? "Edit bug" : "Add bug", body, foot));
  var delBtn = qs("#del-bug");
  if(delBtn) delBtn.addEventListener("click", function(){ r.bugs = r.bugs.filter(function(x){return x.id!==existing.id;}); closeModal(); persistRelease(r); });
  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    var title = qs("#f-title").value.trim();
    if(!title){ qs("#f-title").focus(); return; }
    var severity = (qs('input[name="severity"]:checked')||{}).value || "Medium";
    var status = (qs('input[name="bstatus"]:checked')||{}).value || "Open";
    var bugId = qs("#f-bugid").value.trim();
    var notes = qs("#f-notes").value.trim();
    var isNewBug = !existing;
    if(existing){ existing.bugId=bugId; existing.title=title; existing.severity=severity; existing.status=status; existing.notes=notes; }
    else { r.bugs = r.bugs||[]; r.bugs.push({id:crypto.randomUUID(), bugId:bugId, title:title, severity:severity, status:status, notes:notes}); }
    closeModal();
    var bugRef = existing || r.bugs[r.bugs.length-1];
    persistRelease(r, function(){
      logAudit({
        action: isNewBug ? "KNOWN_BUG_ADDED" : "KNOWN_BUG_UPDATED",
        entityType: "Bug", entityId: bugRef.id,
        details: (bugRef.bugId? bugRef.bugId+" — ":"")+(bugRef.title||"Untitled bug")
      });
    });
  });
}
function openPlatformModal(r, key){
  var p = r.platforms[key];
  var body = '<div class="field"><label>Status</label>'+statusChoiceGroup("pstatus", PLATFORM_STATUSES, p.status)+'</div>'+
    '<div class="field"><label for="f-notes">Notes <span class="hint">(optional)</span></label><textarea id="f-notes" rows="3">'+esc(p.notes||"")+'</textarea></div>';
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Save</button>';
  openModal(modalShell(PLATFORM_LABELS[key]+" platform status", body, foot));
  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    p.status = (qs('input[name="pstatus"]:checked')||{}).value || "NOT TESTED";
    p.notes = qs("#f-notes").value.trim();
    closeModal();
    persistRelease(r, function(){
      logAudit({action:"PLATFORM_UPDATED", entityType:"Platform", entityId:key, details: PLATFORM_LABELS[key]+" → "+p.status});
    });
  });
}
function openBlockerModal(r, existing){
  var b = existing || {title:"", description:"", owner:"", status:"Open"};
  var body =
    '<div class="field"><label for="f-title">Blocker Title</label><input type="text" id="f-title" value="'+escAttr(b.title)+'" required placeholder="e.g. Payment gateway certificate expired"></div>'+
    '<div class="field"><label for="f-desc">Description</label><textarea id="f-desc" rows="3">'+esc(b.description||"")+'</textarea></div>'+
    '<div class="field"><label for="f-owner">Owner</label><input type="text" id="f-owner" value="'+escAttr(b.owner)+'"></div>'+
    '<div class="field"><label>Status</label>'+statusChoiceGroup("blstatus", BLOCKER_STATUSES, b.status)+'</div>';
  var foot = (existing? '<button type="button" class="btn btn-danger" id="del-blocker">'+iconTrash()+' Delete</button>' : '<span></span>')+
    '<span style="flex:1"></span><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">'+(existing?"Save changes":"Add blocker")+'</button>';
  openModal(modalShell(existing? "Edit blocker" : "Add release blocker", body, foot));
  var delBtn = qs("#del-blocker");
  if(delBtn) delBtn.addEventListener("click", function(){ r.blockers = r.blockers.filter(function(x){return x.id!==existing.id;}); closeModal(); persistRelease(r); });
  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    var title = qs("#f-title").value.trim();
    if(!title){ qs("#f-title").focus(); return; }
    var status = (qs('input[name="blstatus"]:checked')||{}).value || "Open";
    var description = qs("#f-desc").value.trim();
    var owner = qs("#f-owner").value.trim();
    var isNewBlocker = !existing;
    if(existing){ existing.title=title; existing.description=description; existing.owner=owner; existing.status=status; }
    else { r.blockers = r.blockers||[]; r.blockers.push({id:crypto.randomUUID(), title:title, description:description, owner:owner, status:status}); }
    closeModal();
    var blockerRef = existing || r.blockers[r.blockers.length-1];
    persistRelease(r, function(){
      logAudit({
        action: isNewBlocker ? "BLOCKER_ADDED" : "BLOCKER_UPDATED",
        entityType: "Blocker", entityId: blockerRef.id,
        details: (blockerRef.title||"Untitled blocker")+" — "+blockerRef.status
      });
    });
  });
}
function openPerformanceModal(r){
  var p = r.performance;
  var body = '<div class="field"><label>Status</label>'+statusChoiceGroup("pfstatus", PERF_STATUSES, p.status)+'</div>'+
    '<div class="field-row">'+field("f-rt","Response Time","text",p.responseTime)+field("f-cu","Concurrent Users","text",p.concurrentUsers)+'</div>'+
    '<div class="field-row">'+field("f-er","Error Rate","text",p.errorRate)+field("f-sla","SLA / Threshold","text",p.sla)+'</div>'+
    '<div class="field"><label for="f-notes">Notes <span class="hint">(optional)</span></label><textarea id="f-notes" rows="3">'+esc(p.notes||"")+'</textarea></div>';
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Save</button>';
  openModal(modalShell("Performance testing details", body, foot));
  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    p.status = (qs('input[name="pfstatus"]:checked')||{}).value || "PASS";
    p.responseTime = qs("#f-rt").value.trim(); p.concurrentUsers = qs("#f-cu").value.trim();
    p.errorRate = qs("#f-er").value.trim(); p.sla = qs("#f-sla").value.trim(); p.notes = qs("#f-notes").value.trim();
    closeModal();
    persistRelease(r, function(){
      logAudit({action:"PERFORMANCE_UPDATED", entityType:"Performance", entityId:r._id, details:"Status: "+p.status});
    });
  });
}
function openSecurityModal(r){
  var s = r.security;
  var body = '<div class="field"><label>Status</label>'+statusChoiceGroup("sestatus", SEC_STATUSES, s.status)+'</div>'+
    '<div class="field-row">'+field("f-crit","Critical Findings","number",s.critical)+field("f-high","High Findings","number",s.high)+'</div>'+
    '<div class="field-row">'+field("f-med","Medium Findings","number",s.medium)+field("f-low","Low Findings","number",s.low)+'</div>'+
    '<div class="field"><label for="f-notes">Notes <span class="hint">(optional)</span></label><textarea id="f-notes" rows="3">'+esc(s.notes||"")+'</textarea></div>';
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Save</button>';
  openModal(modalShell("Security testing details", body, foot));
  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    s.status = (qs('input[name="sestatus"]:checked')||{}).value || "PASS";
    s.critical = clamp(num(qs("#f-crit").value),0,99999); s.high = clamp(num(qs("#f-high").value),0,99999);
    s.medium = clamp(num(qs("#f-med").value),0,99999); s.low = clamp(num(qs("#f-low").value),0,99999);
    s.notes = qs("#f-notes").value.trim();
    closeModal();
    persistRelease(r, function(){
      logAudit({action:"SECURITY_UPDATED", entityType:"Security", entityId:r._id, details:"Status: "+s.status+" ("+s.critical+" critical, "+s.high+" high)"});
    });
  });
}
function openConfirm(title, message, confirmLabel, onConfirm, danger){
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button>'+
    '<button type="button" class="btn '+(danger?"btn-danger":"btn-primary")+'" id="confirm-btn">'+esc(confirmLabel)+'</button>';
  openModal('<div class="modal-head"><h3>'+esc(title)+'</h3><button class="btn btn-icon btn-ghost" data-action="close-modal" aria-label="Close">'+iconClose()+'</button></div><div class="modal-body"><p>'+message+'</p></div><div class="modal-foot">'+foot+'</div>', {confirm:true});
  qs("#confirm-btn").addEventListener("click", function(){ closeModal(); onConfirm(); });
}

/* ============================================================
   RELEASE NOTES ACTIONS
   ============================================================ */
function setNotesGenerating(on){
  var btn = qs('[data-action="generate-notes"]');
  if(!btn) return;
  if(on){
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Generating…';
  } else {
    btn.disabled = false;
    btn.innerHTML = iconSpark()+' Generate Release Notes';
  }
}
function handleGenerateNotes(r){
  var editor = qs("#notes-editor");
  var hasManual = state.notesDirty || (r.releaseNotes && r.releaseNotes.edited && editor && editor.innerHTML.trim());
  var run = function(){
    if(!(r.version||"").trim()){
      showToast("Set this release's Version field first — it's used as the Jira Fix Version to match on.");
      return;
    }
    setNotesGenerating(true);
    // Retrieves the latest Jira data for this release's Fix Version,
    // categorizes it with the existing rule-based logic, and (when AI is
    // configured) asks Google Gemini only for a human-readable
    // title/description per ticket — see server/routes/releases.js for the
    // full pipeline and validation. Every factual field in the result still
    // comes straight from Jira, never from AI.
    api.generateReleaseNotes(r._id).then(function(result){
      // Mutate r in place (rather than swapping in result.release wholesale)
      // so this stays a surgical update to the notes editor, same as before
      // — the rest of the page only picks up the refreshed tickets/items on
      // the next full render (e.g. after Save), exactly like today.
      r.tickets = result.release.tickets;
      r.jira = result.release.jira;
      r.releaseNotes = result.release.releaseNotes;
      r.updatedAt = result.release.updatedAt;

      var html = generateReleaseNotesHtml(r);
      var liveEditor = qs("#notes-editor");
      if(liveEditor) liveEditor.innerHTML = html;
      state.notesDirty = false;
      setNotesGenerating(false);
      updateNotesStatus(r);

      var detail = "Release "+(r.version||r.name||"Untitled")+
        (result.aiUsed ? " — AI-assisted ("+result.aiUsedCount+" ticket"+pluralize(result.aiUsedCount,"","s")+")" : " — rule-based summaries")+
        (result.incidentCount ? ", "+result.incidentCount+" incident"+pluralize(result.incidentCount,"","s") : "");
      logAudit({action:"RELEASE_NOTES_GENERATED", entityType:"Release", entityId:r._id, details:detail});

      (result.warnings||[]).forEach(function(w){ showToast(w); });
    }).catch(function(e){
      setNotesGenerating(false);
      showToast("Couldn't generate release notes: "+e.message);
    });
  };
  if(hasManual) openConfirm("Regenerate release notes?", "Your current edits will be replaced.", "Regenerate", run, false);
  else run();
}
function handleSaveNotes(r){
  var editor = qs("#notes-editor");
  if(!editor) return;
  var html = editor.innerHTML.replace(/<script[\s\S]*?<\/script>/gi, "");
  var wasEdited = r.releaseNotes ? !!r.releaseNotes.edited : false;
  var isManualEdit = state.notesDirty ? true : wasEdited;
  // A manual edit invalidates the per-item AI/rule-based provenance recorded
  // at generation time — those items no longer necessarily reflect what's
  // in the editor, so mark them accordingly rather than silently leaving
  // them tagged as machine-generated. Items that were always manual
  // (MANUALLY_ADDED — see routes/releases.js) are left as-is; that's a
  // distinct, more specific state than "someone edited the generated text".
  var items = (r.releaseNotes && r.releaseNotes.items) || [];
  if(isManualEdit && items.length){
    items = items.map(function(it){
      return it.origin==="MANUALLY_ADDED" ? it : Object.assign({}, it, {origin:"MANUALLY_EDITED"});
    });
  }
  r.releaseNotes = { html: html, edited: isManualEdit, savedAt: new Date().toISOString(),
    items: items, lastGeneratedAt: r.releaseNotes ? r.releaseNotes.lastGeneratedAt : null,
    incidentItems: (r.releaseNotes && r.releaseNotes.incidentItems) || [] };
  state.notesDirty = false;
  persistRelease(r, function(){
    showToast("Release notes saved");
    logAudit({action:"RELEASE_NOTES_UPDATED", entityType:"Release", entityId:r._id, details:"Release "+(r.version||r.name||"Untitled")});
  });
}

/* ============================================================
   MOBILE RELEASE NOTE ACTIONS
   ============================================================ */
function setMobileNoteButtonBusy(action, on, busyLabel, idleHtml){
  var btn = qs('[data-action="'+action+'"]');
  if(!btn) return;
  if(on){
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> '+busyLabel;
  } else {
    btn.disabled = false;
    btn.innerHTML = idleHtml;
  }
}
// Does the actual draft API call + textarea fill — shared by both paths
// into it: the ticket-picker modal's "Generate" (below), and directly here
// when there are no tickets to pick from in the first place. ticketKeys is
// an array of Jira keys to draft from; empty/omitted means "every ticket on
// this release", exactly the original (pre-picker) behavior.
function runDraftMobileNoteEn(r, ticketKeys){
  var keys = ticketKeys || [];
  var doDraft = function(){
    clearMobileNoteValidation("mrn-en-validation");
    setMobileNoteButtonBusy("draft-mobile-note-en", true, "Drafting…", iconSpark()+' Draft from tickets');
    api.draftMobileNoteEn(r._id, keys).then(function(result){
      setMobileNoteButtonBusy("draft-mobile-note-en", false, "", iconSpark()+' Draft from tickets');
      var ta = qs("#mrn-en");
      if(ta) ta.value = result.enUS || "";
      state.mobileNoteDirty = true;
      updateMobileNoteStatus(r);
      updateMobileNoteCounters();
      var sourceNote = keys.length ? " from "+keys.length+" selected ticket"+pluralize(keys.length,"","s") : " from this release's tickets";
      showToast(result.aiUsed ? "Drafted"+sourceNote+" — review before saving." : "Drafted simple bullets"+sourceNote+" (AI drafting isn't configured) — review before saving.");
      var droppedLabels = (result.droppedItems||[]).map(function(it){
        return (it.key? it.key+": ":"")+(it.title||"(untitled ticket)");
      });
      if(result.warning) showMobileNoteValidation("mrn-en-validation", result.warning, droppedLabels, false);
    }).catch(function(e){
      setMobileNoteButtonBusy("draft-mobile-note-en", false, "", iconSpark()+' Draft from tickets');
      showToast("Couldn't draft bullets: "+e.message);
      showMobileNoteValidation("mrn-en-validation", "Couldn't draft bullets: "+e.message, null, true);
    });
  };
  var ta = qs("#mrn-en");
  if(ta && ta.value.trim()){
    openConfirm("Redraft English bullets?", "This replaces the current English text with a fresh draft from "+(keys.length ? "the tickets you selected." : "this release's tickets.")+"", "Redraft", doDraft, false);
  } else doDraft();
}
// "Draft from tickets" opens a picker so specific tickets can be chosen as
// the source — e.g. a release that bundles some internal/non-user-facing
// work the store listing shouldn't mention. Leaving every checkbox unchecked
// and clicking Generate keeps the original behavior exactly: every ticket on
// the release. Skips straight to drafting (no picker) when there's nothing
// to pick from yet — same as before this feature existed.
function openMobileNoteTicketPickerModal(r){
  var tickets = r.tickets || [];
  if(!tickets.length){ runDraftMobileNoteEn(r, []); return; }
  var body =
    '<p class="helper-text">Pick which tickets to draft the English bullets from. Leave none checked to draft from every ticket in this release.</p>'+
    '<div class="field-row" style="margin:0 0 10px;">'+
      '<button type="button" class="btn btn-sm" id="mrn-picker-select-all">Select all</button>'+
      '<button type="button" class="btn btn-sm" id="mrn-picker-clear">Clear</button>'+
    '</div>'+
    '<div class="mrn-ticket-picker-list" id="mrn-picker-list">'+tickets.map(function(t, i){
      var id = "mrn-pick-"+i;
      return '<label class="mrn-ticket-picker-row" for="'+id+'">'+
        '<input type="checkbox" id="'+id+'" value="'+escAttr(t.key)+'">'+
        '<span><span class="mrn-ticket-picker-key">'+esc(t.key)+'</span>'+esc(t.title||"(untitled ticket)")+'</span>'+
      '</label>';
    }).join("")+'</div>';
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">'+iconSpark()+' Generate</button>';
  openModal(modalShell("Draft From Tickets", body, foot), {wide:true});

  var listEl = qs("#mrn-picker-list");
  var selectAllBtn = qs("#mrn-picker-select-all");
  var clearBtn = qs("#mrn-picker-clear");
  if(selectAllBtn) selectAllBtn.addEventListener("click", function(){
    qsa('input[type="checkbox"]', listEl).forEach(function(cb){ cb.checked = true; });
  });
  if(clearBtn) clearBtn.addEventListener("click", function(){
    qsa('input[type="checkbox"]', listEl).forEach(function(cb){ cb.checked = false; });
  });

  qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    var selectedKeys = qsa('input[type="checkbox"]:checked', listEl).map(function(cb){ return cb.value; });
    closeModal();
    runDraftMobileNoteEn(r, selectedKeys);
  });
}
function handleDraftMobileNoteEn(r){
  openMobileNoteTicketPickerModal(r);
}
function handleTranslateMobileNoteAr(r){
  var enTa = qs("#mrn-en");
  var enText = enTa ? enTa.value : "";
  if(!mobileNoteLines(enText).length){
    showToast("Write or draft the English bullets first.");
    return;
  }
  var run = function(){
    clearMobileNoteValidation("mrn-ar-validation");
    setMobileNoteButtonBusy("translate-mobile-note-ar", true, "Translating…", iconSpark()+' Translate from English');
    api.translateMobileNoteAr(r._id, enText).then(function(result){
      setMobileNoteButtonBusy("translate-mobile-note-ar", false, "", iconSpark()+' Translate from English');
      var arTa = qs("#mrn-ar");
      if(arTa) arTa.value = result.ar || "";
      state.mobileNoteDirty = true;
      updateMobileNoteStatus(r);
      updateMobileNoteCounters();
      showToast(result.engine==="gemini"
        ? "Translated with AI — review before saving."
        : "Translated with a free machine-translation service (no AI configured) — review carefully before saving, phrasing may be rougher than AI.");
      if(result.warning) showMobileNoteValidation("mrn-ar-validation", result.warning, result.droppedLines||[], false);
    }).catch(function(e){
      setMobileNoteButtonBusy("translate-mobile-note-ar", false, "", iconSpark()+' Translate from English');
      showToast("Couldn't translate: "+e.message);
      showMobileNoteValidation("mrn-ar-validation", "Couldn't translate: "+e.message, null, true);
    });
  };
  var arTa = qs("#mrn-ar");
  if(arTa && arTa.value.trim()){
    openConfirm("Retranslate Arabic bullets?", "This replaces the current Arabic text with a fresh translation of the English bullets above.", "Retranslate", run, false);
  } else run();
}
function handleSaveMobileNote(r){
  var enTa = qs("#mrn-en");
  var arTa = qs("#mrn-ar");
  r.mobileReleaseNote = {
    enUS: enTa ? enTa.value : "",
    ar: arTa ? arTa.value : "",
    savedAt: new Date().toISOString()
  };
  state.mobileNoteDirty = false;
  persistRelease(r, function(){
    showToast("Mobile release note saved");
    logAudit({action:"MOBILE_RELEASE_NOTE_UPDATED", entityType:"Release", entityId:r._id, details:"Release "+(r.version||r.name||"Untitled")});
  });
}
function handleCopyMobileNote(r){
  var enTa = qs("#mrn-en");
  var arTa = qs("#mrn-ar");
  var enText = enTa ? enTa.value : "";
  var arText = arTa ? arTa.value : "";
  if(!mobileNoteLines(enText).length && !mobileNoteLines(arText).length){
    showToast("Nothing to copy yet — write or draft the bullets first.");
    return;
  }
  var block = formatMobileReleaseNoteBlock(enText, arText);
  var done = function(){ showToast("Copied — paste it into the store submission form."); };
  var failed = function(){ showToast("Couldn't copy automatically — select the text and copy it manually."); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(block).then(done).catch(failed);
  } else {
    try{
      var tmp = document.createElement("textarea");
      tmp.value = block;
      tmp.style.position = "fixed";
      tmp.style.opacity = "0";
      document.body.appendChild(tmp);
      tmp.focus(); tmp.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(tmp);
      ok ? done() : failed();
    }catch(e){ failed(); }
  }
}

/* ============================================================
   PUBLISH
   Marks a release as published with a timestamped snapshot of the current
   AI recommendation, for the record. Purely informational — it never locks
   the release, so every section (including Release Notes) stays editable
   afterward, and publishing again just refreshes the snapshot.
   ============================================================ */
function handlePublishRelease(r){
  var a = computeAssessment(r);
  var already = r.published && r.published.at;
  var tone = a.recommendation==="NO-GO" ? "danger" : a.recommendation==="CONDITIONAL GO" ? "warn" : "go";
  var msg = 'Current recommendation: <strong style="color:var(--'+tone+'-fg)">'+esc(a.recommendation)+'</strong>. '+
    (already ? "This updates the existing publish record with today’s date and recommendation." : "This records that "+esc(releaseLabel(r))+" shipped, with today’s recommendation for reference.");
  openConfirm(already ? "Re-publish this release?" : "Publish this release?", msg, already ? "Re-publish" : "Publish", function(){
    r.published = { at: new Date().toISOString(), recommendation: a.recommendation };
    persistRelease(r).then(function(){ showToast("Release published"); });
  }, false);
}

/* ============================================================
   REGRESSION MODULE SYNC (pulls the master Entity/Service list into a
   release that predates an entity/service, or was created before the
   master list had it — additive only, see server routes/releases.js)
   ============================================================ */
function handleSyncRegressionModules(r){
  var btn = qs('[data-action="sync-regression-modules"]');
  if(btn){ btn.disabled = true; btn.innerHTML = iconRefresh()+' Syncing…'; }
  api.syncRegressionModules(r._id).then(function(result){
    state.releases[r._id] = result.release;
    render();
    var added = [];
    if(result.addedEntities) added.push(result.addedEntities+" new entit"+(result.addedEntities===1?"y":"ies"));
    if(result.addedServices) added.push(result.addedServices+" new service"+pluralize(result.addedServices,"","s"));
    var removed = [];
    if(result.removedEntities) removed.push(result.removedEntities+" entit"+(result.removedEntities===1?"y":"ies")+" removed"+(result.removedNames&&result.removedNames.length? " ("+result.removedNames.join(", ")+")":""));
    if(result.removedServices) removed.push(result.removedServices+" service"+pluralize(result.removedServices,"","s")+" removed");
    var parts = added.concat(removed);
    var msg = parts.length ? "✓ Regression modules synced — "+parts.join(", ") : "✓ Already up to date — nothing to add or remove";
    showToast(msg);
    logAudit({action:"REGRESSION_UPDATED", entityType:"Regression", entityId:r._id, details:"Synced modules — "+(parts.length? parts.join(", ") : "no changes")});
  }).catch(function(e){
    showToast("Sync failed: "+e.message);
    if(btn){ btn.disabled=false; btn.innerHTML = iconRefresh()+' Sync Modules'; }
  });
}

/* ============================================================
   TICKET ACTIONS
   ============================================================ */
function handleResyncJira(r){
  var btn = qs('[data-action="resync-jira"]');
  if(btn){ btn.disabled = true; btn.innerHTML = iconRefresh()+' Syncing…'; }
  api.jiraSync(r._id).then(function(result){
    state.releases[r._id] = result.release;
    render();
    var parts = [];
    if(result.added) parts.push(result.added+" new ticket"+pluralize(result.added,"","s")+" added");
    if(result.updated) parts.push(result.updated+" updated");
    if(result.removed) parts.push(result.removed+" removed — no longer on this Fix Version");
    var msg = parts.length ? "✓ Jira synced — "+parts.join(", ") : "✓ Jira synced — no changes";
    showToast(msg);
    logAudit({action:"JIRA_SYNCED", entityType:"Release", entityId:r._id, details:(result.added||0)+" added, "+(result.updated||0)+" updated"+(result.removed? ", "+result.removed+" removed":"")});
  }).catch(function(e){
    showToast("Sync failed: "+e.message);
    if(btn){ btn.disabled=false; btn.innerHTML = iconRefresh()+' Re-sync Jira'; }
  });
}

/* ============================================================
   EVENT DELEGATION
   ============================================================ */
document.addEventListener("click", function(e){
  var scrollTarget = e.target.closest("[data-scroll]");
  if(scrollTarget){
    var el = document.getElementById(scrollTarget.getAttribute("data-scroll"));
    if(el) el.scrollIntoView({behavior:"smooth", block:"start"});
    return;
  }

  var el2 = e.target.closest("[data-action]");
  // Closes the release-detail "⋮" menu and every per-row Test Data "⋮" menu
  // (there's normally at most one open at a time) whenever the click wasn't
  // on one of their own toggle buttons.
  var menuBtn = e.target.closest('[data-action="toggle-release-menu"], [data-action="toggle-td-menu"], [data-action="toggle-team-menu"], [data-action="toggle-incident-menu"]');
  var openMenus = qsa(".menu.open");
  if(openMenus.length && !menuBtn) openMenus.forEach(function(m){ m.classList.remove("open"); });
  if(!e.target.closest(".search-wrap")) closeSearchDropdown();
  if(!el2) return;
  var action = el2.getAttribute("data-action");
  var id = el2.getAttribute("data-id");
  var key = el2.getAttribute("data-key");
  var entityId = el2.getAttribute("data-entity-id");
  var r = state.route.view==="detail" ? state.releases[state.route.id] : null;

  // Any navigation closes the mobile sidebar drawer, if it's open —
  // harmless no-op on desktop where it's never opened in the first place.
  if(action && action.indexOf("nav-")===0){
    var appBodyEl = qs(".app-body");
    if(appBodyEl) appBodyEl.classList.remove("sidenav-open");
  }

  switch(action){
    case "nav-home": goTo("#/"); break;
    case "nav-list": goTo("#/releases"); break;
    case "nav-audit": goTo("#/audit"); break;
    case "nav-statistics": goTo("#/statistics"); break;
    case "nav-team": goTo("#/team"); break;
    case "nav-detail": goTo("#/r/"+id); break;
    case "toggle-sidenav":
      e.stopPropagation();
      var appBodyToggle = qs(".app-body");
      if(appBodyToggle) appBodyToggle.classList.toggle("sidenav-open");
      break;
    case "close-sidenav":
      var appBodyClose = qs(".app-body");
      if(appBodyClose) appBodyClose.classList.remove("sidenav-open");
      break;
    case "link-identity": openLinkIdentityModal(); break;
    case "sign-out":
      authApi.logout().catch(function(){ /* clearing the cookie server-side best-effort either way */ }).then(function(){ location.href = "/"; });
      break;
    case "create-release": openCreateReleaseModal(); break;
    case "close-modal": closeModal(); break;
    case "edit-release-info": if(r) openEditReleaseInfoModal(r); break;
    case "manage-regression-modules": openManageRegressionModulesModal(); break;
    case "sync-regression-modules": if(r) handleSyncRegressionModules(r); break;
    case "edit-regression-notes":
      if(r){
        var ent = regressionEntities(r).find(function(x){return x.id===entityId;});
        var svc = ent && (ent.services||[]).find(function(x){return x.id===id;});
        if(ent && svc) openRegressionNotesModal(r, ent, svc);
      }
      break;
    case "edit-regression-entity-notes":
      if(r){
        var entN = regressionEntities(r).find(function(x){return x.id===entityId;});
        if(entN) openRegressionEntityNotesModal(r, entN);
      }
      break;
    case "edit-regression-owner":
      if(r){
        var entOwner = regressionEntities(r).find(function(x){return x.id===entityId;});
        if(entOwner) openRegressionAssignModal(r, entOwner);
      }
      break;
    case "edit-regression-module-owner":
      if(r){
        var entMo = regressionEntities(r).find(function(x){return x.id===entityId;});
        var svcMo = entMo && (entMo.services||[]).find(function(x){return x.id===id;});
        if(entMo && svcMo && !entMo._legacy) openRegressionModuleAssignModal(r, entMo, svcMo);
      }
      break;
    case "open-assign-regression": if(r) openBulkAssignRegressionModal(r); break;
    case "set-regression-view": state.regressionView = el2.getAttribute("data-view")||"All"; render(); break;
    case "add-bug": if(r) openBugModal(r, null); break;
    case "edit-bug": if(r){ var bu=(r.bugs||[]).find(function(x){return x.id===id;}); if(bu) openBugModal(r,bu); } break;
    case "delete-bug": if(r){ r.bugs=(r.bugs||[]).filter(function(x){return x.id!==id;}); persistRelease(r); } break;
    case "edit-platform": if(r) openPlatformModal(r, el2.getAttribute("data-key")); break;
    case "add-incident": if(r) openIncidentModal(r, null); break;
    case "toggle-incident-menu":
      e.stopPropagation();
      var incMenu = document.getElementById("incident-menu-"+id);
      if(incMenu) incMenu.classList.toggle("open");
      break;
    case "view-incident": if(r){ var vInc=findIncident(r,id); if(vInc) openIncidentViewModal(r, vInc); } break;
    case "edit-incident": if(r){ var eInc=findIncident(r,id); if(eInc) openIncidentModal(r, eInc); } break;
    case "delete-incident": if(r){ var dInc=findIncident(r,id); if(dInc) confirmDeleteIncident(r, dInc); } break;
    case "set-incident-scope":
      if(r){ setIncidentFilter(r, "scope", el2.getAttribute("data-scope")||"All"); }
      break;
    case "add-blocker": if(r) openBlockerModal(r, null); break;
    case "edit-blocker": if(r){ var bl=(r.blockers||[]).find(function(x){return x.id===id;}); if(bl) openBlockerModal(r,bl); } break;
    case "delete-blocker": if(r){ r.blockers=(r.blockers||[]).filter(function(x){return x.id!==id;}); persistRelease(r); } break;
    case "edit-performance": if(r) openPerformanceModal(r); break;
    case "edit-security": if(r) openSecurityModal(r); break;
    case "generate-notes": if(r) handleGenerateNotes(r); break;
    case "save-notes": if(r) handleSaveNotes(r); break;
    case "draft-mobile-note-en": if(r) handleDraftMobileNoteEn(r); break;
    case "translate-mobile-note-ar": if(r) handleTranslateMobileNoteAr(r); break;
    case "save-mobile-note": if(r) handleSaveMobileNote(r); break;
    case "copy-mobile-note": if(r) handleCopyMobileNote(r); break;
    case "publish-release": if(r) handlePublishRelease(r); break;
    case "download-release-pdf":
      if(r){
        var pdfRoot = qs("#pdf-report");
        if(pdfRoot) pdfRoot.innerHTML = buildPdfReportHtml(r);
        // Browsers suggest the current document title as the default
        // filename in the print/Save-as-PDF dialog — there's no other way
        // to control that from a native print dialog, so swap the tab
        // title to "<release name> <version>" just for this print, then
        // restore it. 'afterprint' is the reliable signal the dialog
        // closed; the timeout is a fallback for browsers that don't fire it.
        var previousTitle = document.title;
        document.title = pdfFileName(r);
        var restoreTitle = function(){
          document.title = previousTitle;
          window.removeEventListener("afterprint", restoreTitle);
        };
        window.addEventListener("afterprint", restoreTitle);
        window.print();
        setTimeout(restoreTitle, 2000);
      }
      break;
    case "add-ticket": if(r) openAddTicketModal(r); break;
    case "edit-ticket": if(r){ var t=(r.tickets||[]).find(function(x){return x.key===key;}); if(t) openEditTicketModal(r,t); } break;
    case "delete-ticket": if(r){ r.tickets=(r.tickets||[]).filter(function(x){return x.key!==key;}); persistRelease(r); } break;
    case "edit-ticket-assignee": if(r){ var ta=(r.tickets||[]).find(function(x){return x.key===key;}); if(ta) openTicketAssigneeModal(r,ta); } break;
    case "resync-jira": if(r && state.jiraStatus.connected) handleResyncJira(r); break;
    case "toggle-ticket-group":
      var gkey = el2.getAttribute("data-key");
      var wasCollapsed = (gkey in state.ticketCollapsed) ? state.ticketCollapsed[gkey] : true;
      state.ticketCollapsed[gkey] = !wasCollapsed;
      var groupEl = document.querySelector('.ticket-group[data-group-key="'+CSS.escape(gkey)+'"]');
      if(groupEl) groupEl.classList.toggle("expanded");
      break;
    case "toggle-release-menu":
      e.stopPropagation();
      var menu = qs("#release-menu");
      if(menu) menu.classList.toggle("open");
      break;
    case "duplicate-release":
      if(r) openConfirm("Duplicate this release?", "A new release will be created from a copy of "+esc(releaseLabel(r))+"’s data. Release notes and Jira sync history are not copied.", "Duplicate", function(){ duplicateRelease(r); }, false);
      break;
    case "delete-release":
      var target = state.releases[id];
      openConfirm("Delete release?", "This permanently deletes "+esc(target?releaseLabel(target):"this release")+" and all of its QA data.", "Delete", function(){ deleteRelease(id); }, true);
      break;
    case "clear-search":
      state.searchQuery = ""; state.searchResults = []; state.searchActiveIndex = -1;
      var searchInput = qs("#global-search");
      if(searchInput){ searchInput.value = ""; searchInput.focus(); }
      closeSearchDropdown();
      el2.hidden = true;
      break;
    case "open-search-result":
      openSearchResult(parseInt(el2.getAttribute("data-result-index"), 10));
      break;
    case "nav-test-data": goTo("#/test-data"); break;
    case "add-test-data": openTestDataModal(null, false); break;
    case "import-test-data": triggerTestDataImportFilePicker(); break;
    case "export-test-data": triggerFileDownload(testDataExportUrl()); break;
    case "td-page-prev":
      if(state.testDataPage>1){
        state.testDataPage--;
        var tdListElPrev = qs("#td-list-container");
        if(tdListElPrev) tdListElPrev.innerHTML = renderTestDataListHtml();
      }
      break;
    case "td-page-next":
      state.testDataPage = (state.testDataPage||1)+1;
      var tdListElNext = qs("#td-list-container");
      if(tdListElNext) tdListElNext.innerHTML = renderTestDataListHtml();
      break;
    case "toggle-td-menu":
      e.stopPropagation();
      var tdMenu = document.getElementById("td-menu-"+id);
      if(tdMenu) tdMenu.classList.toggle("open");
      break;
    case "view-test-data": if(state.testData[id]) openTestDataViewModal(state.testData[id]); break;
    case "edit-test-data": if(state.testData[id]) openTestDataModal(state.testData[id], false); break;
    case "copy-test-data": if(state.testData[id]) openTestDataModal(state.testData[id], true); break;
    case "delete-test-data":
      var tdTarget = state.testData[id];
      openConfirm("Delete this test data?", "This permanently deletes test data for National ID <b>"+esc(tdTarget?tdTarget.nationalId:"")+"</b>.", "Delete", function(){ deleteTestDataRecord(id); }, true);
      break;
    case "clear-td-search":
      state.testDataSearch = "";
      state.testDataPage = 1;
      var tdSearchInput = qs("#td-search");
      if(tdSearchInput){ tdSearchInput.value = ""; tdSearchInput.focus(); }
      var tdListEl = qs("#td-list-container");
      if(tdListEl) tdListEl.innerHTML = renderTestDataListHtml();
      el2.hidden = true;
      break;
    case "add-team-member": openTeamMemberModal(null); break;
    case "toggle-team-menu":
      e.stopPropagation();
      var teamMenu = document.getElementById("team-menu-"+id);
      if(teamMenu) teamMenu.classList.toggle("open");
      break;
    case "edit-team-member": if(state.team[id]) openTeamMemberModal(state.team[id]); break;
    case "delete-team-member":
      var teamTarget = state.team[id];
      openConfirm("Delete this team member?", "This removes <b>"+esc(teamTarget?teamTarget.name:"")+"</b> from Know the Team.", "Delete", function(){ deleteTeamMember(id); }, true);
      break;
    case "toggle-my-team-member":
      setMyLinkedTeamMember(id, myLinkedTeamMemberId()!==id);
      break;
  }
});

document.addEventListener("change", function(e){
  var elp = e.target;
  if(elp.matches('[data-action="toggle-performance"]')){
    var r = state.releases[state.route.id]; if(!r) return;
    r.performance.enabled = elp.checked; persistRelease(r);
  }
  if(elp.matches('[data-action="toggle-security"]')){
    var r2 = state.releases[state.route.id]; if(!r2) return;
    r2.security.enabled = elp.checked; persistRelease(r2);
  }
  if(elp.matches('[data-action="set-incident-filter"]')){
    var rInc = state.releases[state.route.id]; if(!rInc) return;
    setIncidentFilter(rInc, elp.getAttribute("data-filter"), elp.value);
  }
  if(elp.matches('[data-action="toggle-regression-skip"]')){
    var r3 = state.releases[state.route.id]; if(!r3) return;
    r3.regressionSkipped = elp.checked;
    persistRelease(r3, function(){
      logAudit({action:"REGRESSION_UPDATED", entityType:"Regression", entityId:r3._id, details: elp.checked ? "Regression marked as not required" : "Regression re-enabled"});
    });
  }
  if(elp.matches('[data-action="set-regression-status"]')){
    var r4 = state.releases[state.route.id]; if(!r4) return;
    var entId = elp.getAttribute("data-entity-id");
    var svcId = elp.getAttribute("data-id");
    var ent4 = regressionEntities(r4).find(function(x){return x.id===entId;});
    var svc4 = ent4 && (ent4.services||[]).find(function(x){return x.id===svcId;});
    if(!ent4 || !svc4) return;
    // For a legacy (pre-Entities/Services) row, svc4 is a disconnected
    // display copy — write through to the real object so the save sticks.
    var target4 = ent4._legacy ? ent4._legacy : svc4;
    target4.status = elp.value;
    // The audit event (assignedTo / changedBy / previous + new status) is
    // written by the server when this save lands; here we only show the
    // heads-up when the person changing it isn't who it's assigned to.
    var assignee4 = regressionModuleAssigneeId(ent4, svc4);
    persistRelease(r4, function(){ warnIfChangedByOther(assignee4); });
  }
  if(elp.matches('[data-action="set-regression-entity-status"]')){
    var r9 = state.releases[state.route.id]; if(!r9) return;
    var entId9 = elp.getAttribute("data-entity-id");
    var ent9 = regressionEntities(r9).find(function(x){return x.id===entId9;});
    if(!ent9) return;
    ent9.status = elp.value;
    var assignee9 = ent9.assignedTo || "";
    persistRelease(r9, function(){ warnIfChangedByOther(assignee9); });
  }
  if(elp.matches && elp.matches('[data-stats-field]')){
    var sf = state.statsFilters || (state.statsFilters = statsDefaultFilters());
    sf[elp.getAttribute("data-stats-field")] = elp.value;
    render();
  }
  if(elp.id === "ticket-group-by"){
    state.ticketGroupBy = elp.value;
    state.ticketCollapsed = {};
    render();
  }
  if(elp.id === "regression-group-by"){
    state.regressionGroupBy = elp.value;
    render();
  }
});

document.addEventListener("click", function(e){
  var tb = e.target.closest("[data-notes-cmd]");
  if(!tb) return;
  var editor = qs("#notes-editor");
  if(!editor) return;
  editor.focus();
  var cmd = tb.getAttribute("data-notes-cmd");
  if(cmd==="bold") document.execCommand("bold");
  else if(cmd==="italic") document.execCommand("italic");
  else if(cmd==="h2") document.execCommand("formatBlock", false, "H2");
  else if(cmd==="h3") document.execCommand("formatBlock", false, "H3");
  else if(cmd==="p") document.execCommand("formatBlock", false, "P");
  else if(cmd==="ul") document.execCommand("insertUnorderedList");
});

document.addEventListener("input", function(e){
  if(e.target && e.target.id==="notes-editor"){
    state.notesDirty = true;
    var r = state.releases[state.route.id];
    if(r) updateNotesStatus(r);
  }
  if(e.target && (e.target.id==="mrn-en" || e.target.id==="mrn-ar")){
    state.mobileNoteDirty = true;
    var rMrn = state.releases[state.route.id];
    if(rMrn) updateMobileNoteStatus(rMrn);
    updateMobileNoteCounters();
  }
  if(e.target && e.target.id==="global-search"){
    state.searchQuery = e.target.value;
    state.searchResults = buildSearchResults(state.searchQuery);
    state.searchActiveIndex = -1;
    renderSearchDropdown();
    var clearBtn = qs(".search-clear");
    if(clearBtn) clearBtn.hidden = !state.searchQuery;
  }
  if(e.target && e.target.id==="td-search"){
    // Re-renders only the list, not the search input itself, so typing
    // doesn't lose focus on every keystroke (same reasoning as the global
    // search box above, which updates just its dropdown).
    state.testDataSearch = e.target.value;
    state.testDataPage = 1;
    var tdListEl2 = qs("#td-list-container");
    if(tdListEl2) tdListEl2.innerHTML = renderTestDataListHtml();
    var tdClearBtn = qs("#td-search-clear");
    if(tdClearBtn) tdClearBtn.hidden = !state.testDataSearch;
  }
  // Entity/Tags filters are searchable inputs (type="search" + a datalist
  // of existing values) rather than fixed <select> dropdowns — typing
  // narrows the list live, and picking a suggestion just fills in exact
  // text the same way. Same partial-render trick as td-search above, so
  // typing doesn't lose focus.
  if(e.target && e.target.id==="td-entity-filter"){
    state.testDataEntityFilter = e.target.value;
    state.testDataPage = 1;
    var tdListEl3 = qs("#td-list-container");
    if(tdListEl3) tdListEl3.innerHTML = renderTestDataListHtml();
  }
  if(e.target && e.target.id==="td-tag-filter"){
    state.testDataTagFilter = e.target.value;
    state.testDataPage = 1;
    var tdListEl4 = qs("#td-list-container");
    if(tdListEl4) tdListEl4.innerHTML = renderTestDataListHtml();
  }
});

// type="search" inputs fire a "search" event (in addition to "input") when
// their native clear ("×") button is clicked — some browsers don't fire
// "input" for that specific interaction, so this is a safety net to make
// sure clearing via the native button re-filters the list too.
document.addEventListener("search", function(e){
  if(e.target && (e.target.id==="td-entity-filter" || e.target.id==="td-tag-filter")){
    state.testDataPage = 1;
    var tdListEl5 = qs("#td-list-container");
    if(tdListEl5) tdListEl5.innerHTML = renderTestDataListHtml();
  }
});

// Reopen the dropdown when the search box regains focus with a query
// already typed (e.g. tabbing back in) — focus doesn't bubble, so this is
// registered on the capture phase.
document.addEventListener("focus", function(e){
  if(e.target && e.target.id==="global-search" && state.searchQuery && state.searchQuery.trim()){
    renderSearchDropdown();
  }
}, true);

document.addEventListener("keydown", function(e){
  if(!(e.target && e.target.id==="global-search")) return;
  var results = state.searchResults || [];
  if(e.key==="ArrowDown"){
    if(!results.length) return;
    e.preventDefault();
    state.searchActiveIndex = (state.searchActiveIndex+1) % results.length;
    renderSearchDropdown();
    scrollActiveResultIntoView();
  } else if(e.key==="ArrowUp"){
    if(!results.length) return;
    e.preventDefault();
    state.searchActiveIndex = (state.searchActiveIndex-1+results.length) % results.length;
    renderSearchDropdown();
    scrollActiveResultIntoView();
  } else if(e.key==="Enter"){
    if(!results.length) return;
    e.preventDefault();
    openSearchResult(state.searchActiveIndex>-1 ? state.searchActiveIndex : 0);
  } else if(e.key==="Escape"){
    state.searchQuery = ""; state.searchResults = []; state.searchActiveIndex = -1;
    e.target.value = "";
    closeSearchDropdown();
    var clearBtn2 = qs(".search-clear");
    if(clearBtn2) clearBtn2.hidden = true;
    e.target.blur();
  }
});

function duplicateRelease(r){
  api.duplicateRelease(r._id).then(function(clone){
    state.releases[clone._id] = clone;
    showToast("Release duplicated");
    goTo("#/r/"+clone._id);
  }).catch(function(e){ showToast(e.message); });
}
function deleteRelease(id){
  api.deleteRelease(id).then(function(){
    delete state.releases[id];
    state.releaseOrder = state.releaseOrder.filter(function(x){return x!==id;});
    showToast("Release deleted");
    goTo("#/");
  }).catch(function(e){ showToast(e.message); });
}

/* ============================================================
   BOOT
   First finds out (via /auth/me) whether this deployment requires
   Atlassian sign-in at all. If it does and the visitor isn't signed in
   yet, the app stops here and shows the sign-in screen — no release data
   is fetched (it would all 401 anyway) until they come back from a real
   sign-in redirect. Otherwise, boots exactly as before.
   ============================================================ */
function surfaceAuthErrorFromUrl(){
  var params = new URLSearchParams(location.search);
  var authError = params.get("authError");
  if(!authError) return;
  showToast(authError);
  params.delete("authError");
  var qs2 = params.toString();
  history.replaceState(null, "", location.pathname + (qs2? "?"+qs2:"") + location.hash);
}
function initAuthThenBoot(){
  surfaceAuthErrorFromUrl();
  authApi.me().then(function(info){
    state.auth = info;
    renderTopbarUser();
    if(!info.authenticated){
      openSignInModal();
      return; // nothing else loads until they've actually signed in
    }
    state.route = parseHash();
    boot();
  }).catch(function(){
    // Couldn't even reach /auth/me — the server may be down or unreachable.
    // Show a plain error instead of a blank page or a fake logged-out state.
    document.body.innerHTML = '<div style="max-width:32rem;margin:4rem auto;padding:1.5rem;font-family:system-ui,sans-serif;text-align:center;">'+
      '<h2 style="margin:0 0 .5rem;">Can’t reach Greenlight</h2>'+
      '<p style="color:#666;">The server didn’t respond. Check your connection and reload the page.</p>'+
      '</div>';
  });
}
initAuthThenBoot();

})();
