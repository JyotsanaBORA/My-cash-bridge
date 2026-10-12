/**
 * agents.test.js
 * ──────────────────────────────────────────────────────────────────────────
 * End-to-end integration tests for Loan Agent Partner intake & Admin review APIs.
 *
 * HOW TO RUN:
 *   1. Start the server: node server.js
 *   2. In another terminal: node test/agents.test.js
 */

"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const http = require("http");

const HOST      = "127.0.0.1";
const PORT      = parseInt(process.env.PORT, 10) || 3001;
const ADMIN_KEY = process.env.ADMIN_API_KEY || "";
const ORIGIN    = process.env.ALLOWED_ORIGIN || "http://localhost:" + PORT;

const G = "\x1b[32m\u2713\x1b[0m", R = "\x1b[31m\u2717\x1b[0m", Y = "\x1b[33m\u26a0\x1b[0m";
const B = "\x1b[1m", X = "\x1b[0m";
let passed = 0, failed = 0;
const failures = [];

function pass(label)         { passed++; console.log(`  ${G} ${label}`); }
function fail(label, detail) { failed++; const m = `${label}${detail ? " \u2014 " + detail : ""}`; console.log(`  ${R} ${m}`); failures.push(m); }
function warn(label)         { console.log(`  ${Y} ${label}`); }
function section(t)          { console.log(`\n${B}${t}${X}`); }

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: HOST, port: PORT,
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "Origin": ORIGIN,
        "X-Test-Suite": "true",
        ...(opts && opts.headers ? opts.headers : {}),
      },
    };
    if (payload) options.headers["Content-Length"] = Buffer.byteLength(payload);
    const r = http.request(options, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: d });
      });
    });
    r.on("error", reject);
    r.setTimeout(10000, () => { r.destroy(); reject(new Error("timeout")); });
    if (payload) r.write(payload);
    r.end();
  });
}

function adminReq(path, method = "GET", body) {
  return req({
    path,
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": ADMIN_KEY,
      "X-Test-Suite": "true",
    },
  }, body);
}

async function runTests() {
  section("1. Validation & Security — POST /api/agents");

  // Missing name
  const r1 = await req({ path: "/api/agents", method: "POST" }, {
    name: "", mobile: "9876543210", email: "test@example.com", city: "Mumbai", consent: true
  });
  if (r1.status === 400 && /name/i.test(r1.body?.error || "")) {
    pass("Rejects empty applicant name (400)");
  } else {
    fail("Rejects empty applicant name", `status: ${r1.status}`);
  }

  // Invalid mobile
  const r2 = await req({ path: "/api/agents", method: "POST" }, {
    name: "Valid Name", mobile: "12345", email: "test@example.com", city: "Mumbai", consent: true
  });
  if (r2.status === 400 && /mobile/i.test(r2.body?.error || "")) {
    pass("Rejects invalid mobile number (400)");
  } else {
    fail("Rejects invalid mobile number", `status: ${r2.status}`);
  }

  // Invalid email
  const r3 = await req({ path: "/api/agents", method: "POST" }, {
    name: "Valid Name", mobile: "9876543210", email: "not-an-email", city: "Mumbai", consent: true
  });
  if (r3.status === 400 && /email/i.test(r3.body?.error || "")) {
    pass("Rejects invalid email format (400)");
  } else {
    fail("Rejects invalid email format", `status: ${r3.status}`);
  }

  // Missing consent
  const r4 = await req({ path: "/api/agents", method: "POST" }, {
    name: "Valid Name", mobile: "9876543210", email: "test@example.com", city: "Mumbai", consent: false
  });
  if (r4.status === 400 && /consent|terms/i.test(r4.body?.error || "")) {
    pass("Rejects submission without consent (400)");
  } else {
    fail("Rejects submission without consent", `status: ${r4.status}`);
  }

  // Honeypot check
  const r5 = await req({ path: "/api/agents", method: "POST" }, {
    name: "Spam Bot", mobile: "9876543210", email: "bot@example.com", city: "Mumbai", consent: true, _hp: "bot-payload"
  });
  if (r5.status === 400) {
    pass("Rejects honeypot bot attempt (400)");
  } else {
    fail("Rejects honeypot bot attempt", `status: ${r5.status}`);
  }

  section("2. Valid Intake — POST /api/agents");

  const testMobile = "9" + Math.floor(100000000 + Math.random() * 900000000);
  const testEmail = `partner_${Date.now()}@testcashbridge.in`;
  const validPayload = {
    name: "Amit Deshmukh",
    mobile: testMobile,
    email: testEmail,
    city: "Pune",
    agentType: "Direct Selling Agent (DSA)",
    documents: ["PAN Card", "Aadhaar Card", "Bank Statement / Income Proof"],
    consent: true,
    _hp: ""
  };

  const r6 = await req({ path: "/api/agents", method: "POST" }, validPayload);
  let createdAppId = null;
  if (r6.status === 201 && r6.body?.ok && r6.body?.applicationId) {
    createdAppId = r6.body.applicationId;
    pass(`Accepts valid application and returns reference ID: ${createdAppId}`);
  } else {
    fail("Accepts valid application", `status: ${r6.status}, body: ${JSON.stringify(r6.body)}`);
  }

  // Deduplication check
  const r7 = await req({ path: "/api/agents", method: "POST" }, validPayload);
  if (r7.status === 200 && r7.body?.ok && r7.body?.applicationId === createdAppId) {
    pass("Deduplicates immediate repeat submission with 200 OK");
  } else {
    fail("Deduplicates immediate repeat submission", `status: ${r7.status}`);
  }

  section("3. Admin Review APIs — /api/admin/agents");

  // Admin access without key
  const r8 = await req({ path: "/api/admin/agents", method: "GET" });
  if (r8.status === 403 || r8.status === 503) {
    pass("Denies /api/admin/agents without valid X-Admin-Key (403/503)");
  } else {
    fail("Denies /api/admin/agents without valid key", `status: ${r8.status}`);
  }

  if (!ADMIN_KEY) {
    warn("ADMIN_API_KEY not set in .env — skipping authenticated admin review tests.");
  } else {
    // List agents
    const r9 = await adminReq("/api/admin/agents");
    if (r9.status === 200 && r9.body?.ok && Array.isArray(r9.body?.data)) {
      const found = r9.body.data.find(a => a.applicationId === createdAppId);
      if (found) {
        pass(`Admin list endpoint finds created application (${createdAppId})`);
        if (found.status === "pending" && found.city === "Pune") {
          pass("Persisted fields match: status='pending', city='Pune'");
        } else {
          fail("Persisted fields match", `status: ${found.status}, city: ${found.city}`);
        }
      } else {
        fail("Admin list endpoint finds application", "Not found in list");
      }
    } else {
      fail("Admin list endpoint returns 200 array", `status: ${r9.status}`);
    }

    // CSV export
    const r10 = await adminReq("/api/admin/agents?format=csv");
    if (r10.status === 200 && /text\/csv/i.test(r10.headers["content-type"] || "") && r10.raw.includes("applicationId")) {
      pass("Admin export returns downloadable CSV with correct headers");
    } else {
      fail("Admin export returns CSV", `status: ${r10.status}, type: ${r10.headers["content-type"]}`);
    }

    // Update status
    if (createdAppId) {
      const r11 = await adminReq(`/api/admin/agents/${createdAppId}/status`, "PATCH", {
        status: "contacted",
        notes: "Called on phone, requested documents verification."
      });
      if (r11.status === 200 && r11.body?.ok && r11.body?.status === "contacted") {
        pass("Admin PATCH updates application status to 'contacted'");
      } else {
        fail("Admin PATCH updates application status", `status: ${r11.status}, body: ${JSON.stringify(r11.body)}`);
      }
    }

    // Consent stats includes agents
    const r12 = await adminReq("/api/admin/consent-stats");
    if (r12.status === 200 && r12.body?.stats?.agents?.total !== undefined) {
      pass(`Consent stats includes agents summary (total: ${r12.body.stats.agents.total})`);
    } else {
      fail("Consent stats includes agents summary", `status: ${r12.status}`);
    }
  }

  section("Results");
  console.log(`Passed: ${passed} | Failed: ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  } else {
    console.log("\nAll tests passed successfully!");
  }
}

runTests().catch(err => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
