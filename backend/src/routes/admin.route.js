"use strict";

/**
 * admin.route.js — Compliance admin reporting and data management APIs.
 *
 * DPDP Act 2023 and RBI requirements for LSPs:
 * - Maintain auditable records of all DSR requests and grievances.
 * - Produce compliance reports on demand (for regulators, auditors, board).
 * - Export data as CSV for offline analysis.
 *
 * SECURITY: All routes require a valid X-Admin-Key header.
 * Set ADMIN_API_KEY in .env — never commit this value to source control.
 * If ADMIN_API_KEY is not set, all admin endpoints return 503 (not configured).
 *
 * Routes:
 *   GET /api/admin/dsr               — List DSR requests (filterable by status)
 *   GET /api/admin/grievances         — List grievances (filterable by status)
 *   GET /api/admin/retention-logs     — List data anonymization logs
 *   GET /api/admin/consent-stats      — Aggregated consent statistics
 *   GET /api/admin/audit-logs         — Audit log entries
 *   GET /api/admin/processors         — Data processor inventory
 *
 * Add ?format=csv to any list endpoint for a downloadable CSV export.
 */

const { Router } = require("express");
const { getDb }  = require("../db/client");

const router = Router();

/* ── Admin authentication middleware ────────────────────────── */
function adminAuth(req, res, next) {
  if (!process.env.ADMIN_API_KEY) {
    return res.status(503).json({ error: "Admin API not configured. Set ADMIN_API_KEY in .env" });
  }
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({ error: "Forbidden. Valid X-Admin-Key required." });
  }
  next();
}

/* ── CSV helper ─────────────────────────────────────────────── */
function toCSV(rows) {
  if (!rows || !rows.length) return "No data";
  const flatRows = rows.map(row => {
    const flat = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === "_id") continue; // never expose MongoDB ObjectIds
      if (v instanceof Date) { flat[k] = v.toISOString(); continue; }
      if (typeof v === "object" && v !== null) { flat[k] = JSON.stringify(v); continue; }
      flat[k] = v === null || v === undefined ? "" : String(v);
    }
    return flat;
  });
  const headers = Object.keys(flatRows[0]);
  const lines   = [headers.join(",")];
  for (const row of flatRows) {
    lines.push(headers.map(h => {
      const val = String(row[h] === undefined ? "" : row[h]);
      return '"' + val.replace(/"/g, '""') + '"';
    }).join(","));
  }
  return lines.join("\n");
}

function sendResult(res, rows, filename, format) {
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(toCSV(rows));
  }
  return res.json({ ok: true, count: rows.length, data: rows });
}

/* ── GET /api/admin/dsr ─────────────────────────────────────── */
router.get("/api/admin/dsr", adminAuth, async (req, res) => {
  try {
    const db = getDb();
    const filter = req.query.status ? { status: req.query.status } : {};
    const docs = await db.collection("dsrRequests")
      .find(filter, {
        projection: { ticketId: 1, requestType: 1, status: 1, name: 1, mobile: 1, email: 1, createdAt: 1, updatedAt: 1, resolutionNotes: 1 },
      })
      .sort({ createdAt: -1 })
      .limit(2000)
      .toArray();
    return sendResult(res, docs, "dsr-requests.csv", req.query.format);
  } catch (err) {
    console.error("[Admin] DSR list error:", err.message);
    return res.status(500).json({ error: "Query failed." });
  }
});

/* ── GET /api/admin/grievances ──────────────────────────────── */
router.get("/api/admin/grievances", adminAuth, async (req, res) => {
  try {
    const db = getDb();
    const filter = req.query.status ? { status: req.query.status } : {};
    const docs = await db.collection("grievances")
      .find(filter, {
        projection: { ticketId: 1, category: 1, status: 1, priority: 1, name: 1, mobile: 1, email: 1, createdAt: 1, resolvedAt: 1 },
      })
      .sort({ createdAt: -1 })
      .limit(2000)
      .toArray();
    return sendResult(res, docs, "grievances.csv", req.query.format);
  } catch (err) {
    console.error("[Admin] Grievance list error:", err.message);
    return res.status(500).json({ error: "Query failed." });
  }
});

/* ── GET /api/admin/retention-logs ─────────────────────────── */
router.get("/api/admin/retention-logs", adminAuth, async (req, res) => {
  try {
    const db   = getDb();
    const docs = await db.collection("retentionLogs")
      .find({})
      .sort({ timestamp: -1 })
      .limit(2000)
      .toArray();
    return sendResult(res, docs, "retention-logs.csv", req.query.format);
  } catch (err) {
    console.error("[Admin] Retention logs error:", err.message);
    return res.status(500).json({ error: "Query failed." });
  }
});

/* ── GET /api/admin/consent-stats ───────────────────────────── */
router.get("/api/admin/consent-stats", adminAuth, async (req, res) => {
  try {
    const db = getDb();
    const [totalLeads, mktYes, mktNo, cookieAnalytics, cookieMarketing, dsrOpen, dsrResolved, grvOpen, agentsTotal, agentsPending, agentsApproved] =
      await Promise.all([
        db.collection("leads").countDocuments({}),
        db.collection("leads").countDocuments({ "consent.marketingConsent": true }),
        db.collection("leads").countDocuments({ "consent.marketingConsent": false }),
        db.collection("cookieConsents").countDocuments({ analytics: true }),
        db.collection("cookieConsents").countDocuments({ marketing: true }),
        db.collection("dsrRequests").countDocuments({ status: { $in: ["open", "in_progress"] } }),
        db.collection("dsrRequests").countDocuments({ status: { $in: ["resolved", "closed"] } }),
        db.collection("grievances").countDocuments({ status: { $in: ["open", "in_progress"] } }),
        db.collection("agentApplications").countDocuments({}),
        db.collection("agentApplications").countDocuments({ status: "pending" }),
        db.collection("agentApplications").countDocuments({ status: "approved" }),
      ]);
    return res.json({
      ok: true,
      stats: {
        leads:      { total: totalLeads, marketingConsent: mktYes, noMarketingConsent: mktNo },
        cookies:    { analyticsConsent: cookieAnalytics, marketingConsent: cookieMarketing },
        dsr:        { open: dsrOpen, resolved: dsrResolved },
        grievances: { open: grvOpen },
        agents:     { total: agentsTotal, pending: agentsPending, approved: agentsApproved },
      },
    });
  } catch (err) {
    console.error("[Admin] Consent stats error:", err.message);
    return res.status(500).json({ error: "Query failed." });
  }
});

/* ── GET /api/admin/audit-logs ──────────────────────────────── */
router.get("/api/admin/audit-logs", adminAuth, async (req, res) => {
  try {
    const db = getDb();
    const filter = req.query.action ? { action: req.query.action } : {};
    const docs = await db.collection("auditLogs")
      .find(filter, {
        projection: { userId: 1, action: 1, entity: 1, entityId: 1, ip: 1, timestamp: 1, metadata: 1 },
      })
      .sort({ timestamp: -1 })
      .limit(2000)
      .toArray();
    return sendResult(res, docs, "audit-logs.csv", req.query.format);
  } catch (err) {
    console.error("[Admin] Audit logs error:", err.message);
    return res.status(500).json({ error: "Query failed." });
  }
});

/* ── GET /api/admin/processors ──────────────────────────────── */
router.get("/api/admin/processors", adminAuth, async (req, res) => {
  try {
    const db   = getDb();
    const docs = await db.collection("processors").find({}).toArray();
    return sendResult(res, docs, "processors.csv", req.query.format);
  } catch (err) {
    console.error("[Admin] Processors error:", err.message);
    return res.status(500).json({ error: "Query failed." });
  }
});

/* ── GET /api/admin/agents ─────────────────────────────────── */
router.get("/api/admin/agents", adminAuth, async (req, res) => {
  try {
    const db = getDb();
    const filter = req.query.status ? { status: req.query.status } : {};
    const docs = await db.collection("agentApplications")
      .find(filter, {
        projection: {
          applicationId: 1,
          name: 1,
          mobile: 1,
          email: 1,
          city: 1,
          agentType: 1,
          documents: 1,
          status: 1,
          notes: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      })
      .sort({ createdAt: -1 })
      .limit(2000)
      .toArray();
    return sendResult(res, docs, "loan-agent-applications.csv", req.query.format);
  } catch (err) {
    console.error("[Admin] Agents list error:", err.message);
    return res.status(500).json({ error: "Query failed." });
  }
});

/* ── PATCH /api/admin/agents/:id/status ─────────────────────── */
router.patch("/api/admin/agents/:id/status", adminAuth, async (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { status, notes } = req.body || {};

    const validStatuses = ["pending", "in_review", "contacted", "approved", "rejected"];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
    }

    const updateFields = {
      status,
      updatedAt: new Date(),
    };
    if (typeof notes === "string") {
      updateFields.notes = notes.trim().slice(0, 500);
    }

    const result = await db.collection("agentApplications").updateOne(
      { applicationId: id },
      { $set: updateFields }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Agent application not found." });
    }

    const { logAudit } = require("../utils/audit");
    logAudit(db, {
      action:    "AGENT_STATUS_UPDATED",
      entity:    "agentApplications",
      entityId:  id,
      userId:    "admin",
      ip:        req.ip,
      userAgent: req.headers["user-agent"],
      metadata:  { newStatus: status, notes: updateFields.notes },
    });

    return res.json({
      ok: true,
      message: `Application ${id} status updated to ${status}.`,
      applicationId: id,
      status,
    });
  } catch (err) {
    console.error("[Admin] Update agent status error:", err.message);
    return res.status(500).json({ error: "Update failed." });
  }
});

module.exports = router;
