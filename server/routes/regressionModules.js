// The reusable Regression Module master list — what new releases are
// seeded from. Structured as Entity -> Services (e.g. "CSPD" containing
// "Passport services", "Digital Certificates", ...). This route only ever
// reads/replaces that master list; it never touches any release's own
// regression data.
const express = require("express");
const crypto = require("crypto");
const db = require("../db");

const router = express.Router();

router.get("/", (req, res) => {
  res.json(db.regressionModules.list());
});

// PUT replaces the whole list — simplest match for the "Manage Regression
// Modules" modal, which lets the user add/rename/reorder/delete entities
// and services freely and then saves once. Array order is display order,
// both for entities and for each entity's services.
router.put("/", (req, res) => {
  const incoming = req.body;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: "Expected a list of entities." });
  }
  const seenEntityIds = new Set();
  const cleaned = [];
  for (const rawEntity of incoming) {
    const entityName = String((rawEntity && rawEntity.name) || "").trim();
    if (!entityName) continue; // drop blank entities rather than erroring the whole save

    let entityId = rawEntity && typeof rawEntity.id === "string" && rawEntity.id ? rawEntity.id : crypto.randomUUID();
    if (seenEntityIds.has(entityId)) entityId = crypto.randomUUID(); // guard against accidental id collisions
    seenEntityIds.add(entityId);

    const seenServiceIds = new Set();
    const services = [];
    for (const rawService of (rawEntity && rawEntity.services) || []) {
      const serviceName = String((rawService && rawService.name) || "").trim();
      if (!serviceName) continue; // drop blank services
      let serviceId = rawService && typeof rawService.id === "string" && rawService.id ? rawService.id : crypto.randomUUID();
      if (seenServiceIds.has(serviceId)) serviceId = crypto.randomUUID();
      seenServiceIds.add(serviceId);
      services.push({ id: serviceId, name: serviceName });
    }

    cleaned.push({ id: entityId, name: entityName, services });
  }
  const saved = db.regressionModules.set(cleaned);
  res.json(saved);
});

module.exports = router;
