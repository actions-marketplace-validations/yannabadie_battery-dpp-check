#!/usr/bin/env node
/**
 * BatteryDPP-Check (v1.0.0)
 * Zero-dependency Node 20/22+ validator for EU Battery Passport JSON / JSON-LD files
 * under Regulation (EU) 2023/1542 Annex XIII (mandatory 18 February 2027) and GS1 Digital Link QR URIs.
 *
 * Works natively as both a CLI and a GitHub Action (`runs: using: node20`).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL_NAME = "battery-dpp-check";
export const TOOL_VERSION = "1.0.0";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "docs",
  "coverage",
  "vendor",
]);

export const REGULATED_CATEGORIES = new Set(["EV", "LMT", "industrial_gt_2kwh"]);
export const CARBON_CLASSES = new Set(["A", "B", "C", "D", "E"]);

export const RULES_META = [
  { id: "jsonld-context", weight: 8, severity: "error", ref: "ESPR / DPP Interoperability", title: "JSON-LD @context & @type BatteryPassport" },
  { id: "battery-category", weight: 10, severity: "error", ref: "Art. 77(1) Reg. (EU) 2023/1542", title: "Regulated battery category (EV / LMT / industrial_gt_2kwh)" },
  { id: "gs1-digital-link", weight: 14, severity: "error", ref: "Art. 77(3) & GS1 Digital Link", title: "Valid HTTPS GS1 Digital Link QR URI (/01/<GTIN-14>/21/<serial>)" },
  { id: "manufacturer-id", weight: 10, severity: "error", ref: "Annex XIII Part 1(a)", title: "Manufacturer identity & valid EORI / EU VAT / SIREN" },
  { id: "manufacturing-meta", weight: 8, severity: "error", ref: "Annex XIII Part 1(b)", title: "Manufacturing date (YYYY-MM-DD) & ISO-2 country" },
  { id: "carbon-footprint", weight: 12, severity: "error", ref: "Art. 7 & Annex XIII Part 1(f)", title: "Carbon footprint (kg CO2e/kWh), class (A–E) & lifecycle breakdown" },
  { id: "recycled-content", weight: 10, severity: "error", ref: "Art. 8 & Annex XIII Part 1(g)", title: "Recycled content shares (Co, Li, Ni, Pb in 0–100%)" },
  { id: "performance-durability", weight: 10, severity: "error", ref: "Art. 10 & Annex XIII Part 1(h)", title: "Rated capacity, voltage, State of Health (SoH) & cycle life" },
  { id: "due-diligence-ce", weight: 10, severity: "error", ref: "Art. 18, Art. 48 & Annex XIII", title: "CE conformity, EU DoC URL & supply-chain due diligence URL" },
  { id: "access-tiers", weight: 8, severity: "error", ref: "Annex XIII Parts 1–4", title: "Role-based access tiers (public / legitimateInterest / authorities)" },
];

/**
 * Compute GS1 Mod-10 check digit for a 13-digit GTIN body (returns single digit char "0"-"9").
 */
export function computeGtin14CheckDigit(first13) {
  const digits = String(first13 || "").replace(/\D/g, "");
  if (digits.length !== 13) return null;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const n = digits.charCodeAt(i) - 48;
    // Standard GS1 GTIN-14 weights from left (pos 0..12): 3,1,3,1,...
    sum += n * (i % 2 === 0 ? 3 : 1);
  }
  return String((10 - (sum % 10)) % 10);
}

/**
 * Validate a 14-digit GTIN using GS1 Mod-10 check digit.
 */
export function validateGtin14(gtin) {
  const digits = String(gtin || "").trim();
  if (!/^\d{14}$/.test(digits)) return false;
  return computeGtin14CheckDigit(digits.slice(0, 13)) === digits[13];
}

/**
 * Validate standard Luhn check (French 9-digit SIREN).
 */
export function validateSirenLuhn(siren) {
  const d = String(siren || "").replace(/[\s.-]/g, "");
  if (!/^\d{9}$/.test(d) || d === "000000000") return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = d.charCodeAt(8 - i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/**
 * Validate an HTTPS GS1 Digital Link QR URI: https://<host>/01/<GTIN-14>/21/<serial>
 */
export function validateGs1DigitalLink(uri) {
  if (!uri || typeof uri !== "string") {
    return { valid: false, reason: "Missing GS1 Digital Link URI." };
  }
  let parsed;
  try {
    parsed = new URL(uri.trim());
  } catch {
    return { valid: false, reason: "Malformed URI syntax." };
  }
  if (parsed.protocol !== "https:") {
    return { valid: false, reason: "GS1 Digital Link QR URI must use HTTPS." };
  }
  const m = parsed.pathname.match(/\/01\/(\d{14})(?:\/10\/[^/]+)?\/21\/([^/?#]+)/);
  if (!m) {
    return {
      valid: false,
      reason: "Path must follow GS1 Digital Link AI structure /01/<14-digit-GTIN>/21/<serial>.",
    };
  }
  const gtin = m[1];
  const serial = decodeURIComponent(m[2]);
  if (!validateGtin14(gtin)) {
    return {
      valid: false,
      reason: `Invalid GS1 GTIN-14 check digit for "${gtin}" (expected trailing digit ${computeGtin14CheckDigit(gtin.slice(0, 13))}).`,
    };
  }
  if (!serial || serial.length < 2) {
    return { valid: false, reason: "GS1 AI (21) battery serial identifier is too short." };
  }
  return { valid: true, gtin, serial };
}

function isPositiveNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isPercentage(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
}

function isHttpsUrl(v) {
  if (typeof v !== "string") return false;
  try {
    return new URL(v.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate a parsed EU Battery Passport JSON / JSON-LD object against Regulation (EU) 2023/1542 Annex XIII.
 */
export function validateBatteryPassport(doc, fileLabel = "passport.jsonld") {
  const errors = [];
  const warnings = [];
  const failedRules = new Set();

  const fail = (ruleId, message) => {
    const meta = RULES_META.find((r) => r.id === ruleId);
    failedRules.add(ruleId);
    errors.push({ ruleId, ref: meta ? meta.ref : "", message });
  };

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    fail("jsonld-context", "Document root must be a JSON object.");
    return {
      file: fileLabel,
      score: 0,
      status: "NON_COMPLIANT",
      rulesPassed: 0,
      rulesTotal: RULES_META.length,
      errors,
      warnings,
    };
  }

  // 1. JSON-LD @context & @type
  const hasContext = Boolean(doc["@context"]);
  const rawType = Array.isArray(doc["@type"]) ? doc["@type"].join(" ") : String(doc["@type"] || "");
  if (!hasContext || !/(BatteryPassport|DigitalProductPassport)/i.test(rawType)) {
    fail("jsonld-context", "Missing JSON-LD @context or @type containing BatteryPassport / DigitalProductPassport.");
  }

  // 2. Regulated Battery Category (Art. 77(1))
  const cat = String(doc.batteryCategory || "").trim();
  if (!REGULATED_CATEGORIES.has(cat)) {
    fail(
      "battery-category",
      `batteryCategory "${cat || "(missing)"}" must be one of: EV, LMT, industrial_gt_2kwh (mandatory from 18 Feb 2027).`
    );
  }

  // 3. GS1 Digital Link QR URI
  const gs1Uri = doc.gs1DigitalLink || doc.id;
  const gs1Check = validateGs1DigitalLink(gs1Uri);
  if (!gs1Check.valid) {
    fail("gs1-digital-link", gs1Check.reason);
  }

  // 4. Manufacturer Identity & EORI / EU VAT / SIREN
  const mfg = doc.manufacturer || {};
  const eoriOk = typeof mfg.eori === "string" && /^[A-Z]{2}[A-Z0-9]{4,15}$/.test(mfg.eori.trim());
  const vatOk = typeof mfg.vatNumber === "string" && /^[A-Z]{2}[A-Z0-9]{6,14}$/.test(mfg.vatNumber.trim());
  const sirenOk = Boolean(mfg.siren && validateSirenLuhn(mfg.siren));
  if (!mfg.name || !mfg.address || (!eoriOk && !vatOk && !sirenOk)) {
    fail(
      "manufacturer-id",
      "manufacturer must include name, postal address, and at least one valid identifier (EORI, EU VAT, or Luhn-valid SIREN)."
    );
  } else if (mfg.siren && !sirenOk) {
    fail("manufacturer-id", `manufacturer.siren "${mfg.siren}" fails INSEE Luhn validation.`);
  }

  // 5. Manufacturing date & country
  const mfMeta = doc.manufacturing || {};
  const dateOk = typeof mfMeta.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(mfMeta.date.trim());
  const countryOk = typeof mfMeta.country === "string" && /^[A-Z]{2}$/.test(mfMeta.country.trim());
  if (!dateOk || !countryOk) {
    fail("manufacturing-meta", "manufacturing must provide date (YYYY-MM-DD) and ISO-3166-1 alpha-2 country code.");
  }

  // 6. Carbon footprint (Art. 7)
  const cf = doc.carbonFootprint || {};
  const breakdown = cf.lifecycleBreakdown || {};
  const hasBreakdown =
    typeof breakdown.rawMaterial === "number" &&
    typeof breakdown.production === "number" &&
    typeof breakdown.distribution === "number" &&
    typeof breakdown.endOfLife === "number";
  if (!isPositiveNumber(cf.totalKgCo2ePerKwh) || !CARBON_CLASSES.has(String(cf.performanceClass || "").toUpperCase()) || !hasBreakdown) {
    fail(
      "carbon-footprint",
      "carbonFootprint requires positive totalKgCo2ePerKwh, performanceClass (A–E), and numeric lifecycleBreakdown (rawMaterial, production, distribution, endOfLife)."
    );
  }

  // 7. Recycled content shares (Art. 8 — Co, Li, Ni, Pb)
  const rc = doc.recycledContent || {};
  const rcKeys = ["cobaltPct", "lithiumPct", "nickelPct", "leadPct"];
  const missingRc = rcKeys.filter((k) => !isPercentage(rc[k]));
  if (missingRc.length > 0) {
    fail("recycled-content", `recycledContent missing valid 0–100% numeric shares for: ${missingRc.join(", ")}.`);
  } else {
    // Advisory notice on mandatory 2031 Art. 8(2) minimum recycled content thresholds
    if (rc.cobaltPct < 16 || rc.lithiumPct < 6 || rc.nickelPct < 6 || rc.leadPct < 85) {
      warnings.push(
        "Advisory (Art. 8(2) Aug 2031 minimums): recycled content is below 2031 targets (Co>=16%, Li>=6%, Ni>=6%, Pb>=85%). Disclosure-only applies in Feb 2027."
      );
    }
  }

  // 8. Performance & durability (Art. 10)
  const perf = doc.performanceAndDurability || {};
  const capacityOk = isPositiveNumber(perf.ratedCapacityAh) || isPositiveNumber(perf.ratedEnergyKwh);
  const voltOk = isPositiveNumber(perf.nominalVoltageV);
  const sohOk = isPercentage(perf.stateOfHealthPct);
  const cyclesOk = isPositiveNumber(perf.expectedCycleLife);
  if (!capacityOk || !voltOk || !sohOk || !cyclesOk) {
    fail(
      "performance-durability",
      "performanceAndDurability requires ratedCapacityAh/ratedEnergyKwh (>0), nominalVoltageV (>0), stateOfHealthPct (0–100), and expectedCycleLife (>0)."
    );
  }
  if (cat === "industrial_gt_2kwh" && typeof perf.ratedEnergyKwh === "number" && perf.ratedEnergyKwh <= 2) {
    fail(
      "battery-category",
      `batteryCategory is industrial_gt_2kwh but ratedEnergyKwh (${perf.ratedEnergyKwh}) is <= 2 kWh.`
    );
  }

  // 9. Due diligence & CE conformity (Art. 18, Art. 48)
  const comp = doc.compliance || {};
  if (comp.ceConformity !== true || !isHttpsUrl(comp.euDeclarationOfConformityUrl) || !isHttpsUrl(comp.dueDiligenceReportUrl)) {
    fail(
      "due-diligence-ce",
      "compliance requires ceConformity: true, HTTPS euDeclarationOfConformityUrl, and HTTPS dueDiligenceReportUrl."
    );
  }
  if (comp.separateCollectionSymbol !== true) {
    warnings.push("Annex VI: separateCollectionSymbol (crossed-out wheeled bin) should be attested as true.");
  }

  // 10. Annex XIII role-based access tiers
  const tiers = doc.accessTiers || {};
  const tiersOk =
    Array.isArray(tiers.public) &&
    tiers.public.length > 0 &&
    Array.isArray(tiers.legitimateInterest) &&
    tiers.legitimateInterest.length > 0 &&
    Array.isArray(tiers.notifiedBodiesAndAuthorities) &&
    tiers.notifiedBodiesAndAuthorities.length > 0;
  if (!tiersOk) {
    fail(
      "access-tiers",
      "accessTiers must declare non-empty arrays for public, legitimateInterest, and notifiedBodiesAndAuthorities (Annex XIII)."
    );
  }

  let score = 0;
  for (const r of RULES_META) {
    if (!failedRules.has(r.id)) score += r.weight;
  }
  const status = errors.length === 0 ? "COMPLIANT" : score >= 60 ? "PARTIAL" : "NON_COMPLIANT";

  return {
    file: fileLabel,
    batteryCategory: cat || "unknown",
    gs1Gtin14: gs1Check.valid ? gs1Check.gtin : null,
    score,
    status,
    rulesPassed: RULES_META.length - failedRules.size,
    rulesTotal: RULES_META.length,
    errors,
    warnings,
  };
}

export function discoverPassportFiles(targetPath, maxDepth = 4) {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Target path does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (stat.isFile()) return [resolved];

  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), depth + 1);
      } else if (
        entry.isFile() &&
        (/\.(?:jsonld)$/i.test(entry.name) ||
          (/\.json$/i.test(entry.name) &&
            !["package.json", "package-lock.json", "tsconfig.json", "dpp-report.json"].includes(entry.name)))
      ) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(resolved, 0);
  return found.sort();
}

export function renderMarkdownSummary(report) {
  const s = report.summary;
  const lines = [
    "## BatteryDPP-Check — EU Battery Passport (Reg. (EU) 2023/1542 Annex XIII) Audit",
    "",
    `**Status:** \`${s.status}\` | **Average Score:** **${s.averageScore} / 100**`,
    "",
    "| Metric | Value |",
    "|---|---|",
    "| **Legal Basis** | EU Batteries Regulation `(EU) 2023/1542` Annex XIII — **Mandatory `2027-02-18`** (EU DPP Registry live `2026-07-20`) |",
    `| **Passport Files Validated** | ${s.filesValidated} |`,
    `| **Compliant Passports** | **${s.passCount}** / ${s.filesValidated} |`,
    `| **Average Annex XIII Score** | **${s.averageScore} / 100** |`,
    "",
  ];

  if (report.files.length > 0) {
    lines.push("### Per-File Results");
    lines.push("");
    lines.push("| File | Category | GS1 GTIN-14 | Score | Rules Passed | Status |");
    lines.push("|---|---|---|---:|---:|---|");
    for (const f of report.files) {
      lines.push(
        `| \`${f.file}\` | \`${f.batteryCategory}\` | \`${f.gs1Gtin14 || "-"}\` | **${f.score}/100** | ${f.rulesPassed}/${f.rulesTotal} | \`${f.status}\` |`
      );
    }
    lines.push("");
  }

  const allErrors = report.files.flatMap((f) => f.errors.map((e) => ({ ...e, file: f.file })));
  if (allErrors.length > 0) {
    lines.push("### Annex XIII Validation Errors");
    lines.push("");
    lines.push("| File | Rule | Reference | Message |");
    lines.push("|---|---|---|---|");
    for (const e of allErrors.slice(0, 30)) {
      lines.push(`| \`${e.file}\` | \`${e.ruleId}\` | ${e.ref} | ${e.message} |`);
    }
    lines.push("");
  }

  lines.push(
    "_Generated by [BatteryDPP-Check](https://yannabadie.github.io/battery-dpp-check/) (MIT, zero dependencies)._"
  );
  return lines.join("\n");
}

function parseConfig(argv, env) {
  const cfg = {
    target: env.INPUT_TARGET || "examples",
    reportOutput: env["INPUT_REPORT-OUTPUT"] || env.INPUT_REPORT_OUTPUT || "dpp-report.json",
    failOnError: (env["INPUT_FAIL-ON-ERROR"] || env.INPUT_FAIL_ON_ERROR || "true").toLowerCase() !== "false",
    maxDepth: Number.parseInt(env["INPUT_MAX-DEPTH"] || env.INPUT_MAX_DEPTH || "4", 10) || 4,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target" && argv[i + 1]) cfg.target = argv[++i];
    else if (a === "--report" && argv[i + 1]) cfg.reportOutput = argv[++i];
    else if (a === "--no-fail") cfg.failOnError = false;
    else if (a === "--quiet") cfg.quiet = true;
    else if (a === "--help" || a === "-h") {
      console.log(`BatteryDPP-Check v${TOOL_VERSION} — EU Battery Passport (2023/1542) Validator\n\nUsage:\n  node src/validate.mjs [target] [--report dpp-report.json] [--no-fail]`);
      process.exit(0);
    } else if (!a.startsWith("-")) {
      cfg.target = a;
    }
  }
  return cfg;
}

export function runValidation(cfg) {
  const rootDir = path.resolve(cfg.target);
  const baseDir = fs.statSync(rootDir).isDirectory() ? rootDir : path.dirname(rootDir);
  const files = discoverPassportFiles(rootDir, cfg.maxDepth);

  const results = files.map((fp) => {
    const rel = path.relative(baseDir, fp) || path.basename(fp);
    try {
      const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
      return validateBatteryPassport(parsed, rel);
    } catch (err) {
      return {
        file: rel,
        batteryCategory: "unknown",
        gs1Gtin14: null,
        score: 0,
        status: "NON_COMPLIANT",
        rulesPassed: 0,
        rulesTotal: RULES_META.length,
        errors: [{ ruleId: "json-parse", ref: "JSON-LD", message: `Invalid JSON: ${err.message}` }],
        warnings: [],
      };
    }
  });

  const passCount = results.filter((r) => r.status === "COMPLIANT").length;
  const failCount = results.length - passCount;
  const avgScore = results.length
    ? Math.round(results.reduce((a, r) => a + r.score, 0) / results.length)
    : 100;
  const status = failCount === 0 ? "COMPLIANT" : avgScore >= 60 ? "PARTIAL" : "NON_COMPLIANT";

  const reportPath = path.resolve(cfg.reportOutput);
  const report = {
    tool: `${TOOL_NAME}@${TOOL_VERSION}`,
    validatedAt: new Date().toISOString(),
    regulation: {
      name: "EU Batteries Regulation (EU) 2023/1542 — Annex XIII",
      mandatoryDate: "2027-02-18",
      euDppRegistryLiveDate: "2026-07-20",
      coveredCategories: ["EV", "LMT", "industrial_gt_2kwh"],
    },
    summary: {
      filesValidated: results.length,
      passCount,
      failCount,
      averageScore: avgScore,
      status,
    },
    files: results,
  };

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  const markdown = renderMarkdownSummary(report);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n", "utf8");
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `report-path=${reportPath}`,
        `files-validated=${report.summary.filesValidated}`,
        `pass-count=${report.summary.passCount}`,
        `fail-count=${report.summary.failCount}`,
        `average-score=${report.summary.averageScore}`,
        `status=${report.summary.status}`,
      ].join("\n") + "\n",
      "utf8"
    );
  }

  return { report, markdown };
}

const isMain =
  process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  try {
    const cfg = parseConfig(process.argv.slice(2), process.env);
    const { report, markdown } = runValidation(cfg);
    if (!cfg.quiet) console.log(markdown);
    if (cfg.failOnError && report.summary.failCount > 0) {
      console.error(
        `\n[BatteryDPP-Check] FAIL: ${report.summary.failCount} battery passport(s) failed EU Reg. 2023/1542 Annex XIII checks.`
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(`[BatteryDPP-Check] ERROR: ${err.message}`);
    process.exit(2);
  }
}
