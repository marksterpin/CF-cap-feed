#!/usr/bin/env node
/*
 * CapNavigator — CDR business-loan harvester
 * ------------------------------------------
 * Runs SERVER-SIDE (no browser, no CORS). Discovers data holders from the public
 * CDR Register, pulls their BUSINESS_LOANS Product Reference Data (rates, fees,
 * limits), maps each product into the CapNavigator feed schema, and writes a static
 * JSON array the app auto-loads.
 *
 *   node harvest.js                 # full harvest -> docs/business_loans.json
 *   SELFTEST=1 node harvest.js      # offline unit test of the mapper (no network)
 *
 * Config (env, all optional):
 *   OUT_DIR=docs            output directory
 *   CONCURRENCY=6           data holders fetched in parallel
 *   REQUEST_TIMEOUT_MS=12000
 *   MAX_HOLDERS=0           0 = all; set small for a quick test run
 *   HOLDER_FILTER=          comma-sep substrings; if set, only matching brands
 *
 * Requires Node 18+ (uses global fetch).
 */
"use strict";
const fs = require("fs");
const path = require("path");

const REGISTER = "https://api.cdr.gov.au/cdr-register/v1/all/data-holders/brands/summary";
const UA = "CapNavigator-CDR-Harvester/1.1 (+https://github.com/)";
const OUT_DIR = process.env.OUT_DIR || "docs";
const CONCURRENCY = Math.max(1, +process.env.CONCURRENCY || 6);
const TIMEOUT = +process.env.REQUEST_TIMEOUT_MS || 12000;
const MAX_HOLDERS = +process.env.MAX_HOLDERS || 0;
const HOLDER_FILTER = (process.env.HOLDER_FILTER || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
// product categories to harvest: business loans + overdrafts/lines of credit
const CATEGORIES = (process.env.CATEGORIES || "BUSINESS_LOANS,OVERDRAFTS").split(",").map(s => s.trim()).filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = x => { const n = parseFloat(x); return isFinite(n) ? n : null; };
const round2 = x => Math.round(x * 100) / 100;

async function fetchWithTimeout(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

// GET a CDR endpoint with version negotiation (tries x-v down to 1) and 429 backoff.
async function cdrGet(url, xv) {
  const versions = [...new Set([xv, xv - 1, xv - 2, 1].filter(v => v >= 1))];
  for (const v of versions) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetchWithTimeout(url, { headers: { "x-v": String(v), "x-min-v": "1", "Accept": "application/json", "User-Agent": UA } });
      } catch (e) { if (attempt) throw e; await sleep(600); continue; }
      if (res.status === 406) break;                 // version unsupported -> try lower
      if (res.status === 429) { await sleep(1500 * (attempt + 1)); continue; } // rate limited
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }
  }
  throw new Error("no supported version");
}

async function discoverHolders() {
  const j = await cdrGet(REGISTER, 1);
  let arr = Array.isArray(j.data) ? j.data : (j.data && (j.data.dataHolders || j.data.brands)) || [];
  let holders = arr
    .filter(b => b && b.publicBaseUri && (b.brandName || b.legalEntityName))
    .map(b => ({ name: b.brandName || b.legalEntityName, base: String(b.publicBaseUri).replace(/\/+$/, "") }));
  if (HOLDER_FILTER.length) holders = holders.filter(h => HOLDER_FILTER.some(f => h.name.toLowerCase().includes(f)));
  if (MAX_HOLDERS) holders = holders.slice(0, MAX_HOLDERS);
  // de-dupe by base URI
  const seen = new Set();
  return holders.filter(h => !seen.has(h.base) && seen.add(h.base));
}

async function listProducts(base, category) {
  const out = [];
  let url = base + "/cds-au/v1/banking/products?product-category=" + category + "&page-size=1000";
  for (let guard = 0; url && guard < 15; guard++) {
    const j = await cdrGet(url, 3);
    ((j.data && j.data.products) || []).forEach(p => out.push(p));
    url = (j.links && j.links.next) || null;
  }
  return out;
}

async function productDetail(base, id) {
  const j = await cdrGet(base + "/cds-au/v1/banking/products/" + encodeURIComponent(id), 4);
  return j.data || {};
}

// CDR PRD product + detail -> CapNavigator feed schema (null if no comparable rate).
function mapProduct(brandName, p, d, category) {
  const lr = (d.lendingRates || []).map(r => ({ t: r.lendingRateType, rate: num(r.rate) })).filter(r => r.rate != null);
  if (!lr.length) return null; // pricing on application — nothing to compare
  const v = lr.filter(r => r.t === "VARIABLE");
  const rate = ((v.length ? v : lr).sort((a, b) => a.rate - b.rate)[0].rate) * 100;

  let feeFlat = 0, feeMo = 0;
  (d.fees || []).forEach(f => {
    const a = num(f.amount); if (a == null) return;
    const t = (f.feeType || "").toUpperCase();
    if (t === "UPFRONT" || t === "EXIT") feeFlat += a;
    else if (t === "PERIODIC") feeMo += a;
  });

  let min = 5000, max = 5000000, maxTerm = 360;
  (d.constraints || []).forEach(c => {
    const t = (c.constraintType || "").toUpperCase(), val = num(c.additionalValue);
    if (t === "MIN_LIMIT" && val != null) min = val;
    if (t === "MAX_LIMIT" && val != null) max = val;
  });

  const text = ((p.name || "") + " " + (p.description || "")).toLowerCase();
  const secured = /secured/.test(text) && !/unsecured/.test(text);
  const od = category === "OVERDRAFTS";
  const type = od ? (/line of credit/.test(text) ? "line_of_credit" : "overdraft")
                  : (secured ? "secured_term" : "unsecured_term");

  return {
    lender: brandName,
    product: p.name || "Business loan",
    type,
    rate: round2(rate),
    feeFlat: round2(feeFlat),
    feePct: 0,
    feeMo: round2(feeMo),
    min, max,
    maxTerm: od ? 120 : maxTerm,
    sec: (od || secured) ? ["residential", "commercial", "business_assets"]
                         : ["none", "residential", "commercial", "business_assets"],
    trade: 0, turn: 0, fund: 7, io: od,
    feat: ["CDR-sourced product data"],
    source: "CDR",
    category,
    productId: p.productId || null,
    lastUpdated: p.lastUpdated || null,
  };
}

// simple concurrency pool
async function pool(items, n, worker) {
  const q = items.slice();
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (q.length) { const it = q.shift(); try { await worker(it); } catch (e) {} }
  }));
}

async function main() {
  const started = Date.now();
  console.log("Discovering data holders from the CDR Register…");
  const holders = await discoverHolders();
  console.log("  " + holders.length + " data holders to check");

  const products = [];
  const stats = { holders: holders.length, withProducts: 0, mapped: 0, skippedNoRate: 0, byCategory: {}, errors: [] };
  CATEGORIES.forEach(c => stats.byCategory[c] = 0);

  await pool(holders, CONCURRENCY, async (h) => {
    let any = false;
    for (const cat of CATEGORIES) {
      let list;
      try { list = await listProducts(h.base, cat); }
      catch (e) {
        if (cat === CATEGORIES[0]) { stats.errors.push(h.name + ": " + e.message); break; } // holder unreachable — skip remaining categories
        continue; // category unsupported by this holder
      }
      if (!list.length) continue;
      any = true;
      for (const p of list) {
        try {
          const d = await productDetail(h.base, p.productId);
          const m = mapProduct(p.brandName || h.name, p, d, cat);
          if (m) { products.push(m); stats.mapped++; stats.byCategory[cat]++; } else stats.skippedNoRate++;
          await sleep(120); // be polite
        } catch (e) { stats.skippedNoRate++; }
      }
    }
    if (any) stats.withProducts++;
  });

  // de-dupe by lender|product|type, keep lowest rate
  const byKey = new Map();
  for (const r of products) {
    const k = r.lender + "|" + r.product + "|" + r.type;
    if (!byKey.has(k) || r.rate < byKey.get(k).rate) byKey.set(k, r);
  }
  const feed = [...byKey.values()].sort((a, b) => a.lender.localeCompare(b.lender) || a.rate - b.rate);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "business_loans.json"), JSON.stringify(feed, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "business_loans.meta.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    categories: CATEGORIES,
    products: feed.length,
    byCategory: stats.byCategory,
    holdersChecked: stats.holders,
    holdersWithProducts: stats.withProducts,
    skippedNoPublishedRate: stats.skippedNoRate,
    durationSec: Math.round((Date.now() - started) / 1000),
    errors: stats.errors.slice(0, 25),
  }, null, 2));

  console.log(`Done: ${feed.length} products from ${stats.withProducts} holders `
    + `(${stats.skippedNoRate} skipped, pricing-on-application) in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log("Wrote " + path.join(OUT_DIR, "business_loans.json"));
}

// -------- offline self-test (no network): SELFTEST=1 node harvest.js --------
function selfTest() {
  const p = { name: "Business Advantage Variable Loan", description: "Secured variable business loan", productId: "abc-123", brandName: "Test Bank" };
  const d = {
    lendingRates: [{ lendingRateType: "VARIABLE", rate: "0.0899" }, { lendingRateType: "FIXED", rate: "0.0925" }],
    fees: [{ feeType: "UPFRONT", amount: "500" }, { feeType: "PERIODIC", amount: "20" }],
    constraints: [{ constraintType: "MIN_LIMIT", additionalValue: "10000" }, { constraintType: "MAX_LIMIT", additionalValue: "750000" }],
  };
  const m = mapProduct("Test Bank", p, d, "BUSINESS_LOANS");
  console.log("mapProduct →", JSON.stringify(m, null, 2));
  const od = mapProduct("Test Bank", { name: "Business Overdraft", productId: "od-1" },
    { lendingRates: [{ lendingRateType: "VARIABLE", rate: "0.1120" }], fees: [{ feeType: "PERIODIC", amount: "20" }] }, "OVERDRAFTS");
  console.log("overdraft →", JSON.stringify({ type: od.type, rate: od.rate, feeMo: od.feeMo, io: od.io, maxTerm: od.maxTerm }));
  const loc = mapProduct("Test Bank", { name: "Business Line of Credit", productId: "loc-1" },
    { lendingRates: [{ lendingRateType: "VARIABLE", rate: "0.1045" }] }, "OVERDRAFTS");
  const none = mapProduct("Test Bank", { name: "Rate on application loan" }, { lendingRates: [] }, "BUSINESS_LOANS");
  console.log("no-rate product →", none, "(expected null)");
  if (!m || m.rate !== 8.99 || m.feeFlat !== 500 || m.feeMo !== 20 || m.min !== 10000 || m.max !== 750000 || m.type !== "secured_term"
      || !od || od.type !== "overdraft" || od.rate !== 11.2 || od.feeMo !== 20 || od.io !== true || od.maxTerm !== 120
      || !loc || loc.type !== "line_of_credit" || none !== null) {
    console.error("SELF-TEST FAILED"); process.exit(1);
  }
  console.log("SELF-TEST PASSED");
}

if (process.env.SELFTEST) selfTest();
else main().catch(e => { console.error("Harvest failed:", e); process.exit(1); });
