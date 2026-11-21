import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  computeGtin14CheckDigit,
  discoverPassportFiles,
  renderMarkdownSummary,
  runValidation,
  validateBatteryPassport,
  validateGs1DigitalLink,
  validateGtin14,
  validateSirenLuhn,
} from "../src/validate.mjs";

const EV_SAMPLE = JSON.parse(
  fs.readFileSync(new URL("../examples/ev-battery-passport.jsonld", import.meta.url), "utf8")
);
const LMT_SAMPLE = JSON.parse(
  fs.readFileSync(new URL("../examples/lmt-ebike-passport.jsonld", import.meta.url), "utf8")
);

test("computeGtin14CheckDigit & validateGtin14 verify GS1 Mod-10 check digits", () => {
  assert.equal(computeGtin14CheckDigit("0376012345678"), "4");
  assert.equal(validateGtin14("03760123456784"), true);
  assert.equal(validateGtin14("03760123456789"), false);
  assert.equal(validateGtin14("12345"), false);
});

test("validateSirenLuhn validates French 9-digit SIREN numbers", () => {
  assert.equal(validateSirenLuhn("552100554"), true);
  assert.equal(validateSirenLuhn("552100555"), false);
  assert.equal(validateSirenLuhn("000000000"), false);
});

test("validateGs1DigitalLink accepts valid HTTPS /01/<GTIN-14>/21/<serial> and rejects malformed URIs", () => {
  const ok = validateGs1DigitalLink("https://id.example.eu/01/03760123456784/21/BAT-2026-01");
  assert.equal(ok.valid, true);
  assert.equal(ok.gtin, "03760123456784");
  assert.equal(ok.serial, "BAT-2026-01");

  assert.equal(validateGs1DigitalLink("http://id.example.eu/01/03760123456784/21/BAT-1").valid, false);
  assert.equal(validateGs1DigitalLink("https://id.example.eu/01/03760123456789/21/BAT-1").valid, false);
  assert.equal(validateGs1DigitalLink("https://id.example.eu/battery/123").valid, false);
});

test("validateBatteryPassport returns 100/100 COMPLIANT on valid EV and LMT passports", () => {
  const rEv = validateBatteryPassport(EV_SAMPLE, "ev.jsonld");
  assert.equal(rEv.score, 100);
  assert.equal(rEv.status, "COMPLIANT");
  assert.equal(rEv.errors.length, 0);
  assert.equal(rEv.rulesPassed, 10);

  const rLmt = validateBatteryPassport(LMT_SAMPLE, "lmt.jsonld");
  assert.equal(rLmt.score, 100);
  assert.equal(rLmt.status, "COMPLIANT");
});

test("validateBatteryPassport flags industrial_gt_2kwh batteries with <= 2 kWh capacity", () => {
  const badInd = structuredClone(EV_SAMPLE);
  badInd.batteryCategory = "industrial_gt_2kwh";
  badInd.performanceAndDurability.ratedEnergyKwh = 1.5;
  const res = validateBatteryPassport(badInd);
  assert.ok(res.errors.some((e) => e.ruleId === "battery-category"));
  assert.notEqual(res.status, "COMPLIANT");
});

test("validateBatteryPassport flags missing Annex XIII carbon footprint, recycled content & durability fields", () => {
  const broken = structuredClone(EV_SAMPLE);
  delete broken.carbonFootprint;
  broken.recycledContent = { cobaltPct: 12 }; // missing Li, Ni, Pb
  broken.performanceAndDurability = { ratedCapacityAh: -5 };
  const res = validateBatteryPassport(broken);
  const ids = new Set(res.errors.map((e) => e.ruleId));
  assert.ok(ids.has("carbon-footprint"));
  assert.ok(ids.has("recycled-content"));
  assert.ok(ids.has("performance-durability"));
  assert.ok(res.score < 70);
});

test("validateBatteryPassport catches missing CE/due-diligence URLs, invalid SIREN & missing accessTiers", () => {
  const broken = structuredClone(EV_SAMPLE);
  broken.manufacturer.siren = "123456789";
  broken.compliance = { ceConformity: false };
  broken.accessTiers = { public: ["batteryCategory"] };
  const res = validateBatteryPassport(broken);
  const ids = new Set(res.errors.map((e) => e.ruleId));
  assert.ok(ids.has("manufacturer-id"));
  assert.ok(ids.has("due-diligence-ce"));
  assert.ok(ids.has("access-tiers"));
});

test("validateBatteryPassport emits advisory warning when recycled content is below 2031 Art. 8(2) minimums", () => {
  const lowRc = structuredClone(EV_SAMPLE);
  lowRc.recycledContent = { cobaltPct: 10, lithiumPct: 3, nickelPct: 4, leadPct: 80 };
  const res = validateBatteryPassport(lowRc);
  assert.equal(res.status, "COMPLIANT");
  assert.ok(res.warnings.some((w) => w.includes("2031")));
});

test("runValidation validates directory end-to-end, writes JSON report & renders Markdown summary", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "battery-dpp-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "ev.jsonld"), JSON.stringify(EV_SAMPLE, null, 2));
    const outPath = path.join(tmpDir, "dpp-report.json");
    assert.equal(discoverPassportFiles(tmpDir).length, 1);

    const { report, markdown } = runValidation({
      target: tmpDir,
      reportOutput: outPath,
      failOnError: true,
      maxDepth: 2,
      quiet: true,
    });
    assert.equal(report.summary.status, "COMPLIANT");
    assert.equal(report.summary.averageScore, 100);
    assert.ok(fs.existsSync(outPath));
    assert.ok(markdown.includes("2027-02-18"));
    assert.ok(renderMarkdownSummary(report).includes("BatteryDPP-Check"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
