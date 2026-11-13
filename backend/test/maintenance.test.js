"use strict";

const http = require("http");
const assert = require("assert");
const path = require("path");

// Set environment for test before requiring server components
process.env.PORT = "3098";
process.env.ALLOWED_ORIGIN = "*";
process.env.MAINTENANCE_MODE = "true";
process.env.MAINTENANCE_BYPASS_KEY = "fullsite";

function makeRequest(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "localhost",
      port: 3098,
      path: urlPath,
      method: "GET",
      headers: headers,
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on("error", reject);
    req.end();
  });
}

async function runTests() {
  console.log("Starting Maintenance Mode & Bypass Test Suite...\n");

  // Spin up an instance using the server logic
  const express = require("express");
  const app = express();
  const FRONTEND_DIR = path.resolve(__dirname, "..", "..", "frontend");
  const isMaintenanceMode = process.env.MAINTENANCE_MODE !== "false";
  const BYPASS_KEY = process.env.MAINTENANCE_BYPASS_KEY || "fullsite";

  // Replicate middleware from server.js
  app.use((req, res, next) => {
    if (req.query.preview === "off") {
      res.setHeader("Set-Cookie", "mcb_preview=; Path=/; Max-Age=0");
    }

    const isStaticOrApi = 
      req.path.startsWith("/api") ||
      req.path.startsWith("/assets") ||
      req.path === "/health" ||
      /\.(css|js|png|jpg|jpeg|svg|ico|webp|woff2?|json)$/i.test(req.path);

    if (isStaticOrApi) {
      return next();
    }

    const cookieHeader = req.headers.cookie || "";
    const hasPreviewCookie = cookieHeader.includes(`mcb_preview=${BYPASS_KEY}`);
    if (req.query.preview === BYPASS_KEY) {
      res.setHeader("Set-Cookie", `mcb_preview=${BYPASS_KEY}; Path=/; HttpOnly; SameSite=Lax`);
      return next();
    }
    if (hasPreviewCookie && req.query.preview !== "off") {
      return next();
    }

    if (isMaintenanceMode) {
      res.status(503);
      res.setHeader("Retry-After", "3600");
      return res.sendFile(path.join(FRONTEND_DIR, "maintenance.html"));
    }

    next();
  });

  app.use(express.static(FRONTEND_DIR));

  app.use((_req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, "index.html"));
  });

  const server = app.listen(3098);

  try {
    // 1. Root route for public visitor
    console.log("Test 1: GET / (public visitor)");
    const res1 = await makeRequest("/");
    assert.strictEqual(res1.statusCode, 503, "Must return HTTP 503");
    assert(res1.body.includes("We&rsquo;re Upgrading"), "Must serve maintenance.html");
    assert(res1.body.includes("MyCashBridge"), "Must mention MyCashBridge");
    console.log("  PASS: Returned HTTP 503 with maintenance page.\n");

    // 2. Deep subpage for public visitor
    console.log("Test 2: GET /loans/personal-loan.html (public visitor)");
    const res2 = await makeRequest("/loans/personal-loan.html");
    assert.strictEqual(res2.statusCode, 503, "Must return HTTP 503");
    assert(res2.body.includes("We&rsquo;re Upgrading"), "Must serve maintenance.html on subpages");
    console.log("  PASS: Blocked deep URL with 503 maintenance page.\n");

    // 3. Static assets: logo
    console.log("Test 3: GET /assets/logo-cashbridge.svg");
    const res3 = await makeRequest("/assets/logo-cashbridge.svg");
    assert.strictEqual(res3.statusCode, 200, "Asset must return HTTP 200");
    assert(res3.body.includes("<svg"), "Must return valid SVG");
    console.log("  PASS: Served logo SVG.\n");

    // 4. Static assets: Setu mascot
    console.log("Test 4: GET /assets/setu/setu-think.svg");
    const res4 = await makeRequest("/assets/setu/setu-think.svg");
    assert.strictEqual(res4.statusCode, 200, "Mascot must return HTTP 200");
    assert(res4.body.includes("<svg"), "Must return valid SVG");
    console.log("  PASS: Served Setu mascot SVG.\n");

    // 5. Admin bypass via ?preview=fullsite
    console.log("Test 5: GET /?preview=fullsite (admin bypass)");
    const res5 = await makeRequest("/?preview=fullsite");
    assert.strictEqual(res5.statusCode, 200, "Must return HTTP 200");
    assert(res5.body.includes("Borrow with a clear head"), "Must return original homepage");
    assert(res5.headers["set-cookie"], "Must set mcb_preview cookie");
    console.log("  PASS: Successfully bypassed maintenance and set preview cookie.\n");

    // 6. Deep page browsing with cookie
    console.log("Test 6: GET /loans/personal-loan.html with preview cookie");
    const cookie = res5.headers["set-cookie"][0].split(";")[0];
    const res6 = await makeRequest("/loans/personal-loan.html", { Cookie: cookie });
    assert.strictEqual(res6.statusCode, 200, "Must return HTTP 200");
    assert(res6.body.includes("Personal Loan"), "Must serve original personal loan page");
    console.log("  PASS: Deep page accessed with preview cookie.\n");

    // 7. Preview logout / toggle off
    console.log("Test 7: GET /?preview=off with previous cookie");
    const res7 = await makeRequest("/?preview=off", { Cookie: cookie });
    assert.strictEqual(res7.statusCode, 503, "Must return to 503 maintenance page");
    console.log("  PASS: Preview cookie cleared, reverts to maintenance page.\n");

    console.log("All 7 tests passed successfully!");
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});

