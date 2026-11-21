# BatteryDPP-Check — EU Battery Passport (Reg. (EU) 2023/1542) Validator

[![CI](https://github.com/yannabadie/battery-dpp-check/actions/workflows/ci.yml/badge.svg)](https://github.com/yannabadie/battery-dpp-check/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-eab308.svg)](LICENSE)
[![EU Battery Passport](https://img.shields.io/badge/Mandatory-18%20Feb%202027-b45309)](https://yannabadie.github.io/battery-dpp-check/)

**Zero-dependency** GitHub Action, Node 20/22+ CLI, and **100 % browser-side EU Battery Passport JSON-LD Validator & GS1 Digital Link QR Builder** for **EU Batteries Regulation (EU) 2023/1542 Annex XIII**.

- **Free Web Validator & Sample JSON-LD / GS1 QR Builder (EN/FR):** https://yannabadie.github.io/battery-dpp-check/
- **Zero external npm dependencies** (`dependencies: {}`) — instant CI gating for OEMs, EV/LMT e-bike makers & industrial battery importers.

---

## Regulatory Context (November 2026)

- **EU Central DPP Registry:** **LIVE since 20 July 2026**.
- **EU Battery Passport Mandatory Deadline:** **18 February 2027** under Regulation (EU) 2023/1542 Art. 77 & Annex XIII for:
  - Electric Vehicle (**`EV`**) batteries
  - Light Means of Transport (**`LMT`**) batteries (e-bikes, e-scooters)
  - Industrial batteries with capacity **`> 2 kWh`** (`industrial_gt_2kwh`)

---

## 10 Automated Annex XIII & GS1 Checks

1. `jsonld-context` — JSON-LD `@context` & `@type: BatteryPassport`
2. `battery-category` — Regulated scope (`EV` / `LMT` / `industrial_gt_2kwh`, plus `> 2 kWh` guard)
3. `gs1-digital-link` — HTTPS GS1 Digital Link QR URI (`/01/<GTIN-14>/21/<serial>`) with **GS1 Mod-10 check-digit verification**
4. `manufacturer-id` — Manufacturer name, address & EORI / EU VAT / Luhn-valid SIREN
5. `manufacturing-meta` — Manufacturing date (`YYYY-MM-DD`) & ISO-3166-1 alpha-2 country
6. `carbon-footprint` — `totalKgCo2ePerKwh`, performance class (`A–E`) & 4-stage lifecycle breakdown (Art. 7)
7. `recycled-content` — Disclosed recycled shares (`Co`, `Li`, `Ni`, `Pb` `0–100%`) + 2031 Art. 8(2) advisory
8. `performance-durability` — Rated capacity/energy, nominal voltage, State of Health (`SoH %`) & cycle life (Art. 10)
9. `due-diligence-ce` — `ceConformity`, HTTPS EU Declaration of Conformity URL & Art. 48 Due Diligence URL
10. `access-tiers` — Annex XIII role-based separation (`public`, `legitimateInterest`, `notifiedBodiesAndAuthorities`)

---

## Quick Start — GitHub Actions (5 Lines)

```yaml
- uses: actions/checkout@v4
- uses: yannabadie/battery-dpp-check@v1.0.0
  with:
    target: "passports"
    report-output: "dpp-report.json"
    fail-on-error: "true"
```

---

## Companion EU RegTech Suite

- **CRA-SBOM-Guard (EU Cyber Resilience Act Art. 14):** https://yannabadie.github.io/cra-sbom-guard/
- **AccessiKit (EU EAA & French RGAA v5):** https://yannabadie.github.io/accessikit-eaa-rgaa/
- **AIActKit 2026 (EU AI Act Art. 50):** https://yannabadie.github.io/ai-act-art50-guard/
- **FacturKit 2027 (French Factur-X 1.09.2 & 159 PA):** https://yannabadie.github.io/facturkit-2027/

## License

MIT — see [LICENSE](LICENSE).
