"use strict";

const { MongoClient, ServerApiVersion } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME   = process.env.DB_NAME || "mycashbridge";

/**
 * One collection per service category.
 * Each category maps to its own MongoDB collection so leads are
 * naturally segmented and can be queried / exported independently.
 */
const COLLECTIONS = {
  loans:       "leads_loans",
  insurance:   "leads_insurance",
  cards:       "leads_cards",
  investments: "leads_investments",
  general:     "leads_general",
};

/** Fallback for unknown categories */
const DEFAULT_COLLECTION = "leads_general";

/** Master collection — every lead regardless of category */
const MASTER_COLLECTION = "leads";

if (!MONGO_URI) {
  console.error("FATAL: MONGO_URI is not set in .env");
  process.exit(1);
}

const client = new MongoClient(MONGO_URI, {
  serverApi: {
    version:           ServerApiVersion.v1,
    strict:            true,
    deprecationErrors: true,
  },
  maxPoolSize:               20,   // max concurrent connections
  minPoolSize:                2,   // warm connections kept alive
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS:         45000,
  connectTimeoutMS:         8000,
});

let _db;

async function connect() {
  await client.connect();
  _db = client.db(DB_NAME);

  // Create indexes on every category collection — idempotent, safe on every restart
  for (const [category, colName] of Object.entries(COLLECTIONS)) {
    const col = _db.collection(colName);
    await col.createIndex({ mobile: 1, submitted_at: -1 }); // dedup lookup
    await col.createIndex({ submitted_at: -1 });            // dashboard sort
    await col.createIndex({ status: 1, submitted_at: -1 }); // CRM filter
    await col.createIndex({ product_type: 1 });             // filter by product
    console.log(`[DB] Indexes ready — ${DB_NAME}.${colName} (${category})`);
  }

  // Master collection indexes
  const master = _db.collection(MASTER_COLLECTION);
  await master.createIndex({ mobile: 1, submitted_at: -1 });
  await master.createIndex({ submitted_at: -1 });
  await master.createIndex({ service_category: 1, submitted_at: -1 });
  await master.createIndex({ status: 1, submitted_at: -1 });
  await master.createIndex({ product_type: 1 });
  console.log(`[DB] Indexes ready — ${DB_NAME}.${MASTER_COLLECTION} (master)`);

  // ── DPDP Compliance Collections ─────────────────────────────────────────
  // Phase 4: DSR (Data Subject Rights) management
  const dsrCol = _db.collection("dsrRequests");
  await dsrCol.createIndex({ ticketId: 1 }, { unique: true });
  await dsrCol.createIndex({ status: 1, createdAt: -1 });
  await dsrCol.createIndex({ mobile: 1, createdAt: -1 });
  await dsrCol.createIndex({ createdAt: -1 });
  console.log(`[DB] Indexes ready — ${DB_NAME}.dsrRequests`);

  // Phase 5: Grievance management
  const grvCol = _db.collection("grievances");
  await grvCol.createIndex({ ticketId: 1 }, { unique: true });
  await grvCol.createIndex({ status: 1, createdAt: -1 });
  await grvCol.createIndex({ mobile: 1, createdAt: -1 });
  await grvCol.createIndex({ createdAt: -1 });
  console.log(`[DB] Indexes ready — ${DB_NAME}.grievances`);

  // Phase 6: Retention logs (immutable — append-only)
  const retCol = _db.collection("retentionLogs");
  await retCol.createIndex({ timestamp: -1 });
  await retCol.createIndex({ collection: 1, timestamp: -1 });
  console.log(`[DB] Indexes ready — ${DB_NAME}.retentionLogs`);

  // Phase 7: Audit logs (immutable — append-only)
  const auditCol = _db.collection("auditLogs");
  await auditCol.createIndex({ timestamp: -1 });
  await auditCol.createIndex({ action: 1, timestamp: -1 });
  await auditCol.createIndex({ entity: 1, entityId: 1 });
  console.log(`[DB] Indexes ready — ${DB_NAME}.auditLogs`);

  // Phase 8: Cookie consent evidence
  const cookieCol = _db.collection("cookieConsents");
  await cookieCol.createIndex({ timestamp: -1 });
  console.log(`[DB] Indexes ready — ${DB_NAME}.cookieConsents`);

  // Bureau consent records (soft-pull consent evidence per DPDP Act 2023)
  const bureauCol = _db.collection("bureau_consents");
  await bureauCol.createIndex({ consented_at: -1 });
  await bureauCol.createIndex({ mobile: 1, consented_at: -1 });
  await bureauCol.createIndex({ bureau_pull_status: 1 });
  console.log(`[DB] Indexes ready — ${DB_NAME}.bureau_consents`);

  // Loan Agent Applications
  const agentCol = _db.collection("agentApplications");
  await agentCol.createIndex({ applicationId: 1 }, { unique: true });
  await agentCol.createIndex({ mobile: 1, createdAt: -1 });
  await agentCol.createIndex({ email: 1, createdAt: -1 });
  await agentCol.createIndex({ status: 1, createdAt: -1 });
  await agentCol.createIndex({ createdAt: -1 });
  console.log(`[DB] Indexes ready — ${DB_NAME}.agentApplications`);

  // Phase 10: Processor inventory — seed if empty
  await seedProcessorInventory(_db);
}

class MemoryCollection {
  constructor(name) {
    this.name = name;
    this.docs = [];
  }
  async createIndex() { return Promise.resolve(); }
  async insertOne(doc) {
    const d = { ...doc, _id: doc._id || "mem_" + Math.random().toString(36).substring(2, 9) };
    this.docs.push(d);
    return { acknowledged: true, insertedId: d._id };
  }
  async insertMany(docs) {
    const inserted = docs.map(d => ({ ...d, _id: d._id || "mem_" + Math.random().toString(36).substring(2, 9) }));
    this.docs.push(...inserted);
    return { acknowledged: true, insertedCount: inserted.length };
  }
  async findOne(query = {}, options = {}) {
    const list = await this.find(query, options).toArray();
    return list[0] || null;
  }
  find(query = {}, options = {}) {
    let result = this.docs.filter(d => {
      for (const [k, v] of Object.entries(query)) {
        if (v && typeof v === "object") {
          if (v.$gte && d[k] < v.$gte) return false;
          if (v.$in && !v.$in.includes(d[k])) return false;
        } else if (d[k] !== v) {
          return false;
        }
      }
      return true;
    });
    const cursor = {
      sort(s) {
        if (s && typeof s === "object") {
          const key = Object.keys(s)[0];
          const dir = s[key];
          result.sort((a, b) => (dir === -1 ? (b[key] > a[key] ? 1 : -1) : (a[key] > b[key] ? 1 : -1)));
        }
        return cursor;
      },
      limit(n) {
        result = result.slice(0, n);
        return cursor;
      },
      async toArray() {
        if (options && options.projection) {
          return result.map(doc => {
            const projected = {};
            for (const p of Object.keys(options.projection)) {
              if (options.projection[p]) projected[p] = doc[p];
            }
            return projected;
          });
        }
        return [...result];
      }
    };
    return cursor;
  }
  async updateOne(filter, update) {
    const doc = await this.findOne(filter);
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    if (update.$set) {
      Object.assign(doc, update.$set);
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async countDocuments(filter = {}) {
    const res = await this.find(filter).toArray();
    return res.length;
  }
}

let _fallbackDb;
function getFallbackDb() {
  if (!_fallbackDb) {
    const cols = {};
    _fallbackDb = {
      collection(name) {
        if (!cols[name]) cols[name] = new MemoryCollection(name);
        return cols[name];
      }
    };
    seedProcessorInventory(_fallbackDb).catch(() => {});
  }
  return _fallbackDb;
}

function getDb() {
  if (_db) return _db;
  return getFallbackDb();
}

/**
 * Returns the MongoDB collection for a given service_category.
 * Falls back to leads_general for any unknown value.
 */
function getCollectionByCategory(category) {
  const colName = COLLECTIONS[category] || DEFAULT_COLLECTION;
  return getDb().collection(colName);
}

/** Returns the master leads collection (all services combined). */
function getMasterCollection() {
  return getDb().collection(MASTER_COLLECTION);
}

/** @deprecated use getCollectionByCategory(category) instead */
function getCollection() {
  return getDb().collection(DEFAULT_COLLECTION);
}

function isConnected() {
  return !!(client.topology && client.topology.isConnected());
}

async function close() {
  await client.close();
}

/**
 * seedProcessorInventory — Phase 10 (Processor Inventory)
 *
 * DPDP Act 2023 Section 8(3): A Data Fiduciary must enter into a valid contract
 * with every Data Processor processing personal data on its behalf.
 *
 * This seeds the processors collection with all known third-party vendors
 * that handle MyCashBridge customer data. The collection is insertOne-if-empty
 * idempotent — subsequent restarts do NOT duplicate records.
 */
async function seedProcessorInventory(db) {
  const col   = db.collection("processors");
  const count = await col.countDocuments({});
  if (count > 0) return; // already seeded

  const processors = [
    {
      name:           "MongoDB Atlas",
      purpose:        "Primary database — stores all lead, DSR, grievance and consent records",
      category:       "Cloud Database",
      country:        "India (Mumbai region ap-south-1)",
      dataShared:     ["name", "mobile", "city", "income", "employment", "consent", "PII"],
      retention:      "Per DPDP retention policy (90 days / 3 years depending on lead status)",
      dpaInPlace:     true,
      lastReviewDate: new Date("2025-01-01"),
      notes:          "MongoDB Atlas DPA signed. Data residency: Mumbai region.",
    },
    {
      name:           "Hostinger",
      purpose:        "Web hosting and domain — serves mycashbridge.com frontend",
      category:       "Cloud Hosting",
      country:        "India / EU",
      dataShared:     ["IP addresses (server logs)", "access logs"],
      retention:      "30 days server logs",
      dpaInPlace:     true,
      lastReviewDate: new Date("2025-01-01"),
      notes:          "Standard hosting logs. No personal financial data.",
    },
    {
      name:           "WhatsApp Business API (Meta)",
      purpose:        "Customer communication — loan enquiry follow-up",
      category:       "Communication",
      country:        "USA",
      dataShared:     ["name", "mobile", "enquiry details"],
      retention:      "Per WhatsApp Business API terms",
      dpaInPlace:     true,
      lastReviewDate: new Date("2025-01-01"),
      notes:          "Data transferred to USA. Meta SCCs apply.",
    },
    {
      name:           "Domestic LMS (Partner System)",
      purpose:        "Lead management system for partner loan processing",
      category:       "Financial Services Partner",
      country:        "India",
      dataShared:     ["name", "mobile", "city", "income", "employment", "product_type"],
      retention:      "Per partner institution's retention policy",
      dpaInPlace:     false,
      lastReviewDate: new Date("2025-01-01"),
      notes:          "DPA to be executed. Data shared only after consent obtained.",
    },
    {
      name:           "Nodemailer / SMTP Provider",
      purpose:        "Transactional emails — DSR acknowledgements, grievance confirmations",
      category:       "Email",
      country:        "India / varies by SMTP host",
      dataShared:     ["name", "email", "ticket reference"],
      retention:      "Per SMTP provider retention policy",
      dpaInPlace:     false,
      lastReviewDate: new Date("2025-01-01"),
      notes:          "DPA required when SMTP configured. Minimal PII in email body.",
    },
  ];

  await col.insertMany(processors.map(p => ({ ...p, createdAt: new Date() })));
  console.log(`[DB] Processor inventory seeded — ${processors.length} processors`);
}

module.exports = { connect, getDb, getCollection, getCollectionByCategory, getMasterCollection, isConnected, close };
