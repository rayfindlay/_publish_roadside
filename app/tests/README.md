# Compliance test suite

Regression net for `dayCompliance()`, the regulation-evaluation function that determines whether a driver legally needs a full daily log on a given day (AB Reg 317/2002 §78, 160 km exemption).

## Why these tests exist

`dayCompliance()` is the most consequential function in the system. If it returns "exempt" when a driver should be on a full log (or vice versa), the company has a compliance problem during a roadside inspection or NSC audit. These tests pin the function's behavior in 20+ scenarios so any future refactor (GitHub Actions migration, performance changes, code cleanup) can't silently break the regulation logic.

## What's tested

| Section | Scenarios |
|---|---|
| Happy paths | no-driving days, exempt days, full-log days |
| 160 km radius | boundary at exactly 160, just over (161), well over (200) |
| Return-to-start | within 1.5 km tolerance, far from start, missing coords |
| 15-hour shift | 14h compliant, 16h over |
| DVIR coverage | pre only, post only, both present |
| Noise trips | filtering yard re-parks (<100m AND <2min) |
| Math helpers | `roundQuarterHour`, `coordDistKm` |
| Per-trip annotation | `dist_from_start_km` and corrected `outside_radius` (day-start relative, not PPB-relative) |
| Known limitations | multi-driver, midnight crossing, missing day-start coords, documented current behavior, not "correct" |
| Duty segments | `buildSegmentsFromTrips`, empty input, single trip, pre-trip bookend |

## How to run

### Locally (requires Node.js 18+)

```
cd Apps/Norfab_Fleet_Compliance
npm install
npm test
```

Vitest runs all `*.test.mjs` files under `tests/` and prints pass/fail counts. Expected output: all green checkmarks, "Tests: 20+ passed."

### In CI (GitHub Actions)

The Phase 2 migration adds an Actions workflow step that runs `npm install && npm test` on every push. **If any test fails, the workflow refuses to publish**, the live phone view stays on the last successful publish until the regression is fixed.

## Known bugs found by this audit

During the test-writing pass, real production data was inspected to ensure test scenarios reflect reality. One real bug was found and **pinned in a test that captures the current (buggy) behavior**, when the bug is fixed, the test will start failing, which is the signal to update the test to expect correct behavior.

### Bug 1: Midnight-crossing days under-report shift hours

**Scenario:** Kyle Webber 2026-04-02, 22 trips, first start at 1:50 PM, last end at 6:46 AM the next morning. Titan tags both ends under `tripDate=2026-04-02`.

**Bug:** `dayCompliance` computes `shiftMin = max(0, lastEnd - firstStart)`. When `lastEnd_min` (≈406, 6:46 AM the *next* day) is less than `firstStart_min` (≈830, 1:50 PM), the subtraction goes negative and clamps to 0. A ~17 hour shift gets reported as **0 hours**, and `over_shift_limit` reads `false` when it should read `true`.

**Why it's not yet fixed:** the radius check usually catches these days on other grounds (a 17-hour shift typically involves significant distance from day-start). The shift-hours number being wrong is a regulator-relevant misreport but doesn't (in practice) misclassify the day as exempt.

**Fix candidates** (Phase 2.5 cleanup, after GitHub Actions migration):
- Detect `lastEnd < firstStart` and add 24h before computing `shiftMin`, OR
- Bifurcate the day at midnight, attributing pre-midnight trips to date N and post-midnight trips to date N+1
- The right answer depends on what NSC/AB regulators consider a "day" for shift purposes, needs confirmation with your SFC consultant.

## What's NOT tested (yet)

Things acknowledged as out of scope for these tests:

- **DST transitions**: Alberta observes DST. `dayCompliance` uses `dayISO` as a string match against `t.date`, which is also a string. Time zone math is not exercised. Need a scenario when this becomes relevant.
- **NSC scope distinction (heavy vs light units)**: `dayCompliance` evaluates every driver-day regardless of unit class. NSC HOS rules technically only apply to ≥11,794 kg GVW. If the system ever filters by NSC scope, tests here will need updating.
- **Cycle hours (7-day / 14-day rolling)**: `dayCompliance` is a single-day function. Cycle hours are computed elsewhere by summing dayCompliance results across multiple days. Cycle logic should have its own test file when it's added.
- **Audit-trail traceability**: source-file references in compliance output aren't tested here. Belongs to a separate test for the publisher.
- **Dustin's multi-vehicle days**: 2 known cases in production (2026-01-16, 2026-04-02). A test pins the current behavior (one combined verdict across both units). If NSC/AB rules require per-unit compliance evaluation on multi-vehicle days, the test will need updating.

## Adding a new scenario

1. Decide what regulation question the test answers ("what does the system do when X?")
2. Use the `trip()` and `dvir()` helpers in the test file to build synthetic input
3. Call `dayCompliance(driverId, dayISO, trips, dvir)` and assert the relevant fields of the returned object
4. Name the test in plain English so anyone reading the suite can understand it without reading the code

## Why we extract compliance logic into a separate module

The function lives in two places right now: `data.js` (loaded by the browser, runs the phone view + dashboard) and `lib/compliance.mjs` (this module, tested here). They must stay in sync. The long-term plan is for `data.js` to import from `lib/compliance.mjs` directly so there's one source of truth, that migration is part of Phase 2.5 cleanup after GitHub Actions lands.

Until that migration, treat `lib/compliance.mjs` as canonical. If you find a bug in the compliance logic, fix it here first, run the tests, then port the same fix to `data.js`.
