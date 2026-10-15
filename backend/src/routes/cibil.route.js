"use strict";

const { Router } = require("express");
const { cibilLimiter } = require("../middleware/rateLimiter");
const { getDb } = require("../db/client");
const { logAudit } = require("../utils/audit");

const router = Router();

// Indian PAN format: 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F)
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
// Indian 10-digit mobile starting with 6, 7, 8, or 9
const MOBILE_RE = /^[6-9]\d{9}$/;
// Indian 6-digit postal code
const PINCODE_RE = /^\d{6}$/;
// Date of birth format YYYY-MM-DD
const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Generates a realistic simulated CIBIL response for development or sandbox testing
 * when SIGNZY_AUTH_TOKEN is not yet set in .env.
 */
function generateSimulatedCibilReport(payload) {
  // Deterministic score based on phone & PAN so repeated checks are consistent
  const seed = (payload.phoneNumber.slice(-4) + payload.panNumber.slice(5, 9))
    .split("")
    .reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const scoresPool = [745, 768, 782, 810, 720, 690, 755];
  const simScore = scoresPool[seed % scoresPool.length];

  return {
    _isSimulated: true,
    CIBILReport: {
      consumerCreditData: [
        {
          names: [{ name: `${payload.firstName} ${payload.lastName}` }],
          scores: [{ score: String(simScore) }]
        }
      ],
      consumerSummaryData: {
        accountSummary: {
          totalAccounts: 4,
          overdueAccounts: 0,
          currentBalance: 145000,
          overdueBalance: 0,
          oldestDateOpened: "2019-06-18"
        },
        inquirySummary: {
          inquiryPast30Days: 1,
          inquiryPast12Months: 3,
          totalInquiry: 6
        }
      }
    },
    CIBILPDF: null
  };
}

/**
 * Handler for CIBIL Consumer Bureau check via Signzy
 */
async function handleCibilCheck(req, res) {
  try {
    const body = req.body || {};

    // 1. Honeypot check (anti-bot)
    if (body._hp) {
      return res.status(400).json({ success: false, error: "Invalid request detected." });
    }

    // 2. Extract and sanitize inputs
    const firstName   = (body.firstName || "").trim().toUpperCase().slice(0, 60);
    const lastName    = (body.lastName || "").trim().toUpperCase().slice(0, 60);
    const genderRaw   = (body.gender || "").trim();
    const gender      = genderRaw.charAt(0).toUpperCase() + genderRaw.slice(1).toLowerCase();
    const phoneNumber = (body.phoneNumber || body.mobile || "").replace(/\D/g, "").slice(-10);
    const panNumber   = (body.panNumber || body.pan || "").trim().toUpperCase().slice(0, 10);
    const dateOfBirth = (body.dateOfBirth || body.dob || "").trim();
    const pincode     = (body.pincode || "").replace(/\D/g, "").slice(0, 6);
    const address     = (body.address || "").trim().slice(0, 250);
    const consentGiven =
      body.consent === true ||
      body.consent === "true" ||
      body.consent === 1 ||
      body.consentFlag === true ||
      (typeof body.consent === "object" && body.consent !== null && (body.consent.consentFlag === true || body.consent.consentFlag === "true"));

    // 3. Strict Validation per Signzy API Requirements
    if (!firstName || firstName.length < 2) {
      return res.status(400).json({ success: false, error: "Please provide a valid first name (as on PAN)." });
    }
    if (!lastName || lastName.length < 1) {
      return res.status(400).json({ success: false, error: "Please provide your last name (as on PAN)." });
    }
    if (!["Male", "Female", "Transgender"].includes(gender)) {
      return res.status(400).json({ success: false, error: "Gender must be 'Male', 'Female', or 'Transgender'." });
    }
    if (!MOBILE_RE.test(phoneNumber)) {
      return res.status(400).json({ success: false, error: "Please enter a valid 10-digit Indian mobile number." });
    }
    if (!PAN_RE.test(panNumber)) {
      return res.status(400).json({ success: false, error: "Please enter a valid 10-character PAN number (e.g. ABCDE1234F)." });
    }
    if (!DOB_RE.test(dateOfBirth)) {
      return res.status(400).json({ success: false, error: "Please enter date of birth in YYYY-MM-DD format." });
    }
    if (!PINCODE_RE.test(pincode)) {
      return res.status(400).json({ success: false, error: "Please enter a valid 6-digit postal PIN code." });
    }
    if (!address || address.length < 5) {
      return res.status(400).json({ success: false, error: "Please provide your complete residential address." });
    }
    if (!consentGiven) {
      return res.status(400).json({
        success: false,
        error: "Consent is required: you must authorize MyCashBridge to perform this credit bureau inquiry."
      });
    }

    // 4. Client IP resolution for audit & bureau evidence
    const clientIp = (
      req.headers["x-forwarded-for"] ||
      req.socket?.remoteAddress ||
      req.ip ||
      "127.0.0.1"
    ).split(",")[0].trim();

    // 5. Construct payload matching Signzy Bureau API specification
    const signzyPayload = {
      firstName,
      lastName,
      gender,
      phoneNumber,
      panNumber,
      dateOfBirth,
      pincode,
      address,
      consent: {
        consentFlag: true,
        consentTimestamp: Math.floor(Date.now() / 1000),
        consentIpAddress: clientIp
      }
    };

    // 6. Signzy API Endpoint Resolution
    const isProd = (process.env.SIGNZY_ENV || "").toLowerCase() === "production";
    const signzyHost = isProd ? "https://api.signzy.app" : "https://api-preproduction.signzy.app";
    const signzyUrl  = `${signzyHost}/api/v3/bureau/cibil-consumer-report`;
    const authToken  = process.env.SIGNZY_AUTH_TOKEN;

    let apiData = null;

    if (!authToken) {
      console.warn("[Signzy CIBIL] SIGNZY_AUTH_TOKEN is not set in .env. Returning simulated CIBIL response for development.");
      apiData = generateSimulatedCibilReport(signzyPayload);
    } else {
      console.log(`[Signzy CIBIL] Querying ${signzyUrl} for PAN: ${panNumber.slice(0, 5)}****${panNumber.slice(-1)}`);
      
      const response = await fetch(signzyUrl, {
        method: "POST",
        headers: {
          "Authorization": authToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(signzyPayload)
      });

      const json = await response.json().catch(() => ({}));

      if (!response.ok) {
        console.error("[Signzy CIBIL] Error response from Signzy:", response.status, json);
        const errMsg = json.error?.message || json.message || `Bureau API error (status ${response.status})`;
        return res.status(response.status >= 400 && response.status < 500 ? 400 : 502).json({
          success: false,
          error: errMsg,
          details: json
        });
      }

      apiData = json.data || json;
    }

    // 7. Parse Response Fields
    const cibilReport = apiData.CIBILReport || {};
    const consumerCreditData = (cibilReport.consumerCreditData && cibilReport.consumerCreditData[0]) || {};
    const scores = consumerCreditData.scores || [];
    const rawScore = scores[0]?.score;
    const score = (rawScore !== undefined && rawScore !== null && rawScore !== "") ? parseInt(rawScore, 10) : null;

    // Score Range / Band Calculation
    // 800+ => Excellent (Green)
    // 750 - 799 => Very Good (Green)
    // 700 - 749 => Good (Teal)
    // 650 - 699 => Fair (Amber)
    // < 650 => Poor (Red)
    let scoreBand = "Poor";
    let scoreBandColor = "#dc2626";
    if (score === null || isNaN(score) || score <= 0) {
      scoreBand = "No Credit History / NTC";
      scoreBandColor = "#64748b";
    } else if (score >= 800) {
      scoreBand = "Excellent";
      scoreBandColor = "#0a5e3a";
    } else if (score >= 750) {
      scoreBand = "Very Good";
      scoreBandColor = "#0c7a4e";
    } else if (score >= 700) {
      scoreBand = "Good";
      scoreBandColor = "#0284c7";
    } else if (score >= 650) {
      scoreBand = "Fair";
      scoreBandColor = "#d97706";
    }

    const names = consumerCreditData.names || [];
    const reportName = names[0]?.name || `${firstName} ${lastName}`;
    const pdfUrl = apiData.CIBILPDF || apiData.cibilPdf || apiData.pdfUrl || apiData.reportPdf?.url || apiData.data?.CIBILPDF || cibilReport.CIBILPDF || null;

    console.log(`[Signzy CIBIL] Report processed for: ${reportName}. Score: ${score} (${scoreBand}). Official Bureau PDF: ${pdfUrl ? 'Available (S3)' : 'None'}`);

    const summaryData = cibilReport.consumerSummaryData || {};
    const accountSummary = summaryData.accountSummary || {};
    const inquirySummary = summaryData.inquirySummary || {};

    const checkId = "cibil_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);

    // 8. Record Evidence & Store in MongoDB
    const db = getDb();
    try {
      await db.collection("cibil_checks").insertOne({
        checkId,
        firstName,
        lastName,
        phoneNumber,
        maskedPan: panNumber.slice(0, 5) + "****" + panNumber.slice(-1),
        gender,
        dateOfBirth,
        pincode,
        address,
        score,
        scoreBand,
        reportName,
        hasPdf: !!pdfUrl,
        pdfUrl,
        accountSummary: {
          totalAccounts: Number(accountSummary.totalAccounts) || 0,
          overdueAccounts: Number(accountSummary.overdueAccounts) || 0,
          currentBalance: Number(accountSummary.currentBalance) || 0,
          overdueBalance: Number(accountSummary.overdueBalance) || 0,
          oldestDateOpened: accountSummary.oldestDateOpened || null
        },
        inquirySummary: {
          inquiryPast30Days: Number(inquirySummary.inquiryPast30Days) || 0,
          inquiryPast12Months: Number(inquirySummary.inquiryPast12Months) || 0,
          totalInquiry: Number(inquirySummary.totalInquiry) || 0
        },
        consent: signzyPayload.consent,
        isSimulated: !!apiData._isSimulated,
        createdAt: new Date()
      });

      // Also capture lead in leads_general for follow-up loan offers
      await db.collection("leads_general").insertOne({
        name: `${firstName} ${lastName}`,
        mobile: phoneNumber,
        city: address.split(",").slice(-2)[0]?.trim() || pincode,
        cibil_score: score ? String(score) : "NTC",
        product_type: "Free CIBIL check",
        status: "NEW",
        submitted_at: new Date(),
        source_page: "tools/credit-score",
        cibil_check_id: checkId
      });

      await logAudit(db, {
        action: "CIBIL_SCORE_CHECKED",
        entity: "cibil_checks",
        entityId: checkId,
        ip: clientIp,
        metadata: {
          score,
          scoreBand,
          maskedPan: panNumber.slice(0, 5) + "****" + panNumber.slice(-1),
          isSimulated: !!apiData._isSimulated
        }
      });
    } catch (dbErr) {
      console.error("[CIBIL Route] DB persistence error:", dbErr.message);
    }

    // 9. Send response to frontend
    const responsePayload = {
      success: true,
      checkId,
      score,
      cibilScore: score,
      scoreBand,
      scoreBandColor,
      reportName,
      pdfUrl,
      pdfReportUrl: pdfUrl,
      accountSummary: {
        totalAccounts: Number(accountSummary.totalAccounts) || 0,
        overdueAccounts: Number(accountSummary.overdueAccounts) || 0,
        currentBalance: Number(accountSummary.currentBalance) || 0,
        overdueBalance: Number(accountSummary.overdueBalance) || 0,
        oldestDateOpened: accountSummary.oldestDateOpened || "N/A"
      },
      inquirySummary: {
        inquiryPast30Days: Number(inquirySummary.inquiryPast30Days) || 0,
        inquiryPast12Months: Number(inquirySummary.inquiryPast12Months) || 0,
        totalInquiry: Number(inquirySummary.totalInquiry) || 0
      },
      isSimulated: !!apiData._isSimulated,
      timestamp: new Date().toISOString()
    };

    // Include nested data copy for clients expecting res.data
    responsePayload.data = { ...responsePayload };

    return res.status(200).json(responsePayload);

  } catch (err) {
    console.error("[CIBIL Route] Unexpected exception:", err);
    return res.status(500).json({
      success: false,
      error: "An error occurred while fetching your credit score. Please try again shortly."
    });
  }
}

// Routes
router.post("/api/cibil/check", cibilLimiter, handleCibilCheck);
router.post("/api/v3/bureau/cibil-consumer-report", cibilLimiter, handleCibilCheck);
router.post("/api/bureau/cibil-consumer-report", cibilLimiter, handleCibilCheck);

module.exports = router;
