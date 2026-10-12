"use strict";

const { Router } = require("express");
const { agentLimiter } = require("../middleware/rateLimiter");
const { getDb } = require("../db/client");
const { logAudit } = require("../utils/audit");
const { sendAgentWelcomeEmail, sendAdminAgentAlert } = require("../utils/mailer");

const router = Router();

// Indian mobile regex: 10 digits starting with 6, 7, 8, or 9
const MOBILE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * POST /api/agents
 *
 * Submits a new loan agent / partner application.
 */
router.post("/api/agents", agentLimiter, async (req, res) => {
  try {
    const body = req.body || {};

    // 1. Honeypot check
    if (body._hp) {
      return res.status(400).json({ error: "Spam detected." });
    }

    // 2. Extract and sanitize fields
    const name      = (body.name || "").trim().slice(0, 100);
    const mobile    = (body.mobile || "").replace(/[\s\-\+]/g, "").slice(-10);
    const email     = (body.email || "").trim().toLowerCase().slice(0, 120);
    const city      = (body.city || "").trim().slice(0, 100);
    const agentType = (body.agentType || "Individual / Consultant").trim().slice(0, 100);
    const consent   = body.consent === true || body.consent === "true" || body.consent === 1;

    const rawDocs   = Array.isArray(body.documents) ? body.documents : [];
    const documents = rawDocs
      .filter((d) => typeof d === "string")
      .map((d) => d.trim().slice(0, 80))
      .filter(Boolean);

    // 3. Validation
    if (!name || name.length < 2) {
      return res.status(400).json({ error: "Please provide a valid full name (minimum 2 characters)." });
    }
    if (!MOBILE_RE.test(mobile)) {
      return res.status(400).json({ error: "Please enter a valid 10-digit Indian mobile number." });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    if (!city || city.length < 2) {
      return res.status(400).json({ error: "Please provide your city / location." });
    }
    if (!consent) {
      return res.status(400).json({ error: "Please accept the terms and consent to be contacted." });
    }

    const db = getDb();

    // 4. Deduplication: same mobile in last 10 minutes
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const recent = await db.collection("agentApplications").findOne({
      mobile,
      createdAt: { $gte: tenMinAgo },
    });

    if (recent) {
      return res.status(200).json({
        ok: true,
        message: "Application already received. We will get back to you after reviewing.",
        applicationId: recent.applicationId,
      });
    }

    // 5. Generate Application Reference ID
    const applicationId = "AGT-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).substring(2, 6).toUpperCase();

    const applicationDoc = {
      applicationId,
      name,
      mobile,
      email,
      city,
      agentType,
      documents,
      status: "pending", // pending | in_review | contacted | approved | rejected
      notes: "",
      consent: {
        accepted: true,
        version: "1.0",
        timestamp: new Date(),
        ip: req.ip || "",
        userAgent: req.headers["user-agent"] || "",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // 6. Save to DB
    await db.collection("agentApplications").insertOne(applicationDoc);

    // 7. Fire-and-forget emails
    sendAgentWelcomeEmail({ to: email, name, applicationId }).catch((err) => {
      console.warn("[Agents] Failed to send applicant welcome email:", err.message);
    });

    sendAdminAgentAlert({
      name,
      mobile,
      email,
      city,
      agentType,
      documents,
      applicationId,
    }).catch((err) => {
      console.warn("[Agents] Failed to send admin alert email:", err.message);
    });

    // 8. Audit log
    logAudit(db, {
      action:    "AGENT_APPLICATION_SUBMITTED",
      entity:    "agentApplications",
      entityId:  applicationId,
      ip:        req.ip,
      userAgent: req.headers["user-agent"],
      metadata:  { name, mobile, email, city, agentType },
    });

    return res.status(201).json({
      ok: true,
      message: "Application submitted successfully. We will get back to you after reviewing.",
      applicationId,
    });
  } catch (err) {
    console.error("[Agents] Application submission error:", err);
    return res.status(500).json({ error: "Failed to submit application. Please try again later." });
  }
});

module.exports = router;
