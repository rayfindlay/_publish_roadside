// Canonical scenarios for dayCompliance(driverId, dayISO, trips, dvir).
//
// These tests are the regression net for the regulation-evaluation logic.
// Any future refactor (GitHub Actions migration, performance changes,
// code reorganization) is safe as long as these all still pass.
//
// Scenario naming convention: each test name describes the input situation
// followed by the expected outcome. Reading the test names should give a
// non-developer a clear picture of what the system does in each case.

import { describe, test, expect } from "vitest";
import {
  dayCompliance,
  isNoiseTrip,
  coordDistKm,
  roundQuarterHour,
  buildSegmentsFromTrips,
  SHIFT_LIMIT_HOURS,
  RETURN_TOLERANCE_KM,
  RADIUS_LIMIT_KM,
} from "../lib/compliance.mjs";

// ---------- helpers for building synthetic test data ----------

// PPB (carrier home terminal), used only for "driver started day at PPB" scenarios.
const PPB = { lat: 53.585, lng: -113.561 };

// Generate a coord offset N km north of an origin (rough approximation,
// good enough for test scenarios, latitude degrees are ~111 km each).
function nKmNorth(origin, km) {
  return [origin.lat + (km / 111.0), origin.lng];
}
function nKmEast(origin, km) {
  // longitude degrees vary by latitude; at 53° N, ~66 km per degree
  return [origin.lat, origin.lng + (km / 66.0)];
}

// Build a trip in the shape adaptTrip() emits.
function trip({
  id = 1,
  driver = "drv1",
  unit = "FDT15",
  date = "2026-05-19",
  start_min = 9 * 60,       // 09:00
  end_min = 10 * 60,        // 10:00
  km = 5,
  startCoords = [PPB.lat, PPB.lng],
  endCoords = [PPB.lat, PPB.lng],
  endingOdometer = 100000,
} = {}) {
  return {
    id, driver, unit, date,
    start_min, end_min, km,
    tripStart: `${date} ${String(Math.floor(start_min / 60)).padStart(2, "0")}:${String(start_min % 60).padStart(2, "0")}:00 AM`,
    tripEnd:   `${date} ${String(Math.floor(end_min / 60)).padStart(2, "0")}:${String(end_min % 60).padStart(2, "0")}:00 AM`,
    startCoords, endCoords,
    endingOdometer,
    flags: [],
    outside_radius: false,
    returned: true,
  };
}

// Build a DVIR record in the shape adaptInspection() emits.
function dvir({
  driver = "drv1",
  unit = "FDT15",
  date_local = "2026-05-19",
  trip_type = "Pre",
  time_min = 8 * 60 + 30,  // 08:30
  odometer_km = 100000,
} = {}) {
  return {
    driver, unit, date_local, trip_type,
    time_local: `${Math.floor(time_min / 60)}:${String(time_min % 60).padStart(2, "0")} AM`,
    time_min,
    odometer_km,
  };
}

// ---------- HAPPY PATHS ----------

describe("happy paths", () => {
  test("no trips at all → state=none (no driving today)", () => {
    const result = dayCompliance("drv1", "2026-05-19", [], []);
    expect(result.state).toBe("none");
    expect(result.trips).toBe(0);
    expect(result.km).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  test("single trip within radius, returned to start, short shift → exempt", () => {
    const trips = [
      trip({ start_min: 9 * 60, end_min: 10 * 60, km: 20,
             startCoords: [PPB.lat, PPB.lng], endCoords: [PPB.lat, PPB.lng] }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.state).toBe("exempt");
    expect(result.outside).toBe(false);
    expect(result.allReturned).toBe(true);
    expect(result.over_shift_limit).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  test("three trips, all within 50 km of day-start, returned → exempt", () => {
    const start = [PPB.lat, PPB.lng];
    const site1 = nKmNorth(PPB, 30);
    const site2 = nKmEast(PPB, 40);
    const trips = [
      trip({ id: 1, start_min: 8 * 60, end_min: 9 * 60,  km: 30, startCoords: start, endCoords: site1 }),
      trip({ id: 2, start_min: 9 * 60, end_min: 11 * 60, km: 30, startCoords: site1, endCoords: site2 }),
      trip({ id: 3, start_min: 11 * 60, end_min: 12 * 60, km: 40, startCoords: site2, endCoords: start }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.state).toBe("exempt");
    expect(result.max_radius_km).toBeGreaterThan(0);
    expect(result.max_radius_km).toBeLessThan(RADIUS_LIMIT_KM);
    expect(result.allReturned).toBe(true);
  });

  test("trip exceeds 160 km from day-start → full-log with 'outside radius' reason", () => {
    const start = [PPB.lat, PPB.lng];
    const farSite = nKmNorth(PPB, 200);
    const trips = [
      trip({ start_min: 7 * 60, end_min: 12 * 60, km: 200, startCoords: start, endCoords: farSite }),
      trip({ id: 2, start_min: 12 * 60, end_min: 17 * 60, km: 200, startCoords: farSite, endCoords: start }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.state).toBe("full-log");
    expect(result.outside).toBe(true);
    expect(result.max_radius_km).toBeGreaterThan(RADIUS_LIMIT_KM);
    expect(result.reasons[0]).toMatch(/operated outside 160 km/);
  });

  test("driver does not return to day-start → full-log with 'did not return' reason", () => {
    const start = [PPB.lat, PPB.lng];
    const site = nKmNorth(PPB, 50);
    const trips = [
      trip({ start_min: 9 * 60, end_min: 10 * 60, km: 50, startCoords: start, endCoords: site }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.state).toBe("full-log");
    expect(result.allReturned).toBe(false);
    expect(result.reasons[0]).toMatch(/did not return/);
  });
});

// ---------- 160 km RADIUS BOUNDARY ----------

describe("160 km radius boundary (AB Reg 317/2002 §78 condition a)", () => {
  test("just inside 160 km boundary (~155 km) → exempt", () => {
    // Haversine math approximation: 1.40 degrees latitude ≈ 155 km at AB
    // latitudes. The point of this test isn't testing "exactly 160 km",
    // haversine coordinate math is non-linear so we can't construct a coord
    // that's exactly 160 km via simple division. Instead we test "clearly
    // inside boundary → exempt" and rely on the next test for "clearly
    // outside → flagged" to bracket the boundary behavior.
    const start = [PPB.lat, PPB.lng];
    const justInside = [PPB.lat + 1.40, PPB.lng];  // ~155 km north
    const trips = [
      trip({ start_min: 7 * 60, end_min: 10 * 60, km: 155, startCoords: start, endCoords: justInside }),
      trip({ id: 2, start_min: 10 * 60, end_min: 13 * 60, km: 155, startCoords: justInside, endCoords: start }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.max_radius_km).toBeLessThan(RADIUS_LIMIT_KM);
    expect(result.outside).toBe(false);
    expect(result.state).toBe("exempt");
  });

  test("161 km from day-start → full-log (just outside)", () => {
    const start = [PPB.lat, PPB.lng];
    const at161 = [PPB.lat + (161 / 111), PPB.lng];
    const trips = [
      trip({ start_min: 7 * 60, end_min: 10 * 60, km: 161, startCoords: start, endCoords: at161 }),
      trip({ id: 2, start_min: 10 * 60, end_min: 13 * 60, km: 161, startCoords: at161, endCoords: start }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.outside).toBe(true);
    expect(result.state).toBe("full-log");
  });
});

// ---------- RETURN-TO-START BOUNDARY ----------

describe("return-to-start tolerance (condition b, 1.5 km tolerance)", () => {
  test("ended within 1.5 km of day-start → returned (exempt)", () => {
    const start = [PPB.lat, PPB.lng];
    // ~1 km away
    const nearby = [PPB.lat + (1 / 111), PPB.lng];
    const trips = [
      trip({ start_min: 9 * 60, end_min: 10 * 60, km: 30, startCoords: start, endCoords: nearby }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.allReturned).toBe(true);
    expect(result.state).toBe("exempt");
  });

  test("ended 5 km from day-start → did NOT return (full-log)", () => {
    const start = [PPB.lat, PPB.lng];
    const far = nKmNorth(PPB, 5);
    const trips = [
      trip({ start_min: 9 * 60, end_min: 10 * 60, km: 30, startCoords: start, endCoords: far }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.allReturned).toBe(false);
    expect(result.state).toBe("full-log");
  });

  test("missing endCoords → conservatively NOT returned (full-log)", () => {
    const start = [PPB.lat, PPB.lng];
    const trips = [
      trip({ start_min: 9 * 60, end_min: 10 * 60, km: 30, startCoords: start, endCoords: null }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.allReturned).toBe(false);
    expect(result.state).toBe("full-log");
    expect(result.reasons.some(r => /coordinates/.test(r))).toBe(true);
  });
});

// ---------- 15-HOUR SHIFT LIMIT ----------

describe("15-hour shift limit (condition c)", () => {
  test("14h shift, all else compliant → exempt", () => {
    const start = [PPB.lat, PPB.lng];
    const trips = [
      trip({ start_min: 6 * 60, end_min: 20 * 60, km: 100, startCoords: start, endCoords: start }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.shift_hrs).toBe(14);
    expect(result.over_shift_limit).toBe(false);
    expect(result.state).toBe("exempt");
  });

  test("16h shift, all else compliant → full-log on shift limit alone", () => {
    const start = [PPB.lat, PPB.lng];
    const trips = [
      trip({ start_min: 5 * 60, end_min: 21 * 60, km: 100, startCoords: start, endCoords: start }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.shift_hrs).toBe(16);
    expect(result.over_shift_limit).toBe(true);
    expect(result.state).toBe("full-log");
    expect(result.reasons.some(r => /shift exceeded/.test(r))).toBe(true);
  });
});

// ---------- DVIR COVERAGE ----------

describe("DVIR (pre/post-trip inspection) tracking", () => {
  test("pre-trip only, no post-trip → pre is found, post is null", () => {
    const start = [PPB.lat, PPB.lng];
    const trips = [
      trip({ start_min: 9 * 60, end_min: 10 * 60, km: 20, startCoords: start, endCoords: start }),
    ];
    const dvirs = [dvir({ trip_type: "Pre", time_min: 8 * 60 + 45 })];
    const result = dayCompliance("drv1", "2026-05-19", trips, dvirs);
    expect(result.pre).not.toBeNull();
    expect(result.post).toBeNull();
    expect(result.pre.time_min).toBe(8 * 60 + 45);
  });

  test("both pre and post DVIRs present → both found", () => {
    const start = [PPB.lat, PPB.lng];
    const trips = [
      trip({ start_min: 9 * 60, end_min: 17 * 60, km: 50, startCoords: start, endCoords: start }),
    ];
    const dvirs = [
      dvir({ trip_type: "Pre", time_min: 8 * 60 + 30 }),
      dvir({ trip_type: "Post", time_min: 17 * 60 + 15 }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, dvirs);
    expect(result.pre).not.toBeNull();
    expect(result.post).not.toBeNull();
  });
});

// ---------- NOISE TRIP FILTER ----------

describe("noise trip filtering (yard re-parks, idle blips)", () => {
  test("trip < 100m AND < 2min is classified as noise", () => {
    const noiseTrip = { km: 0.05, start_min: 540, end_min: 541 };
    expect(isNoiseTrip(noiseTrip)).toBe(true);
  });

  test("trip >= 100m is NOT noise even if very short", () => {
    const realTrip = { km: 0.5, start_min: 540, end_min: 541 };
    expect(isNoiseTrip(realTrip)).toBe(false);
  });

  test("trip >= 2 min is NOT noise even if very short distance", () => {
    const realTrip = { km: 0.05, start_min: 540, end_min: 545 };
    expect(isNoiseTrip(realTrip)).toBe(false);
  });

  test("noise trips are excluded from compliance calculation", () => {
    const start = [PPB.lat, PPB.lng];
    const trips = [
      // The "real" trip
      trip({ id: 1, start_min: 9 * 60, end_min: 10 * 60, km: 20, startCoords: start, endCoords: start }),
      // Yard puttering, should be filtered out
      trip({ id: 2, start_min: 10 * 60, end_min: 10 * 60 + 1, km: 0.05, startCoords: start, endCoords: start }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.trips).toBe(1);  // only the real trip
  });
});

// ---------- MATH HELPERS ----------

describe("math helpers", () => {
  test("roundQuarterHour rounds to nearest 0.25", () => {
    expect(roundQuarterHour(1.0)).toBe(1.0);
    expect(roundQuarterHour(1.1)).toBe(1.0);
    expect(roundQuarterHour(1.125)).toBe(1.25);  // exactly halfway, rounds up
    expect(roundQuarterHour(1.13)).toBe(1.25);
    expect(roundQuarterHour(1.49)).toBe(1.5);
  });

  test("roundQuarterHour returns 0 for non-finite", () => {
    expect(roundQuarterHour(Infinity)).toBe(0);
    expect(roundQuarterHour(NaN)).toBe(0);
  });

  test("coordDistKm returns null for missing inputs", () => {
    expect(coordDistKm(null, [1, 2])).toBe(null);
    expect(coordDistKm([1, 2], null)).toBe(null);
  });

  test("coordDistKm computes a realistic distance", () => {
    // Edmonton to Calgary ≈ 280 km
    const edmonton = [53.5, -113.5];
    const calgary  = [51.0, -114.0];
    const km = coordDistKm(edmonton, calgary);
    expect(km).toBeGreaterThan(260);
    expect(km).toBeLessThan(300);
  });
});

// ---------- TRIP ANNOTATION ----------

describe("per-trip annotation (dist_from_start_km, outside_radius)", () => {
  test("dayTrips returned include dist_from_start_km on each", () => {
    const start = [PPB.lat, PPB.lng];
    const farSite = nKmNorth(PPB, 50);
    const trips = [
      trip({ start_min: 9 * 60, end_min: 10 * 60, km: 50, startCoords: start, endCoords: farSite }),
      trip({ id: 2, start_min: 10 * 60, end_min: 11 * 60, km: 50, startCoords: farSite, endCoords: start }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.dayTrips[0].dist_from_start_km).toBeCloseTo(50, 0);
    expect(result.dayTrips[1].dist_from_start_km).toBeCloseTo(50, 0);  // farSite is 50 km from start
  });

  test("outside_radius on per-trip is recomputed from day-start, not PPB", () => {
    // Driver starts day at home (10 km north of PPB), drives 5 km, returns home.
    // Distance from PPB is up to 15 km, but distance from day-start is only 5 km.
    // outside_radius should be FALSE (we use day-start, not PPB).
    const home = nKmNorth(PPB, 10);
    const errand = nKmNorth(PPB, 15);  // 5 km north of home
    const trips = [
      trip({ start_min: 9 * 60, end_min: 10 * 60, km: 5, startCoords: home, endCoords: errand }),
      trip({ id: 2, start_min: 10 * 60, end_min: 11 * 60, km: 5, startCoords: errand, endCoords: home }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.dayTrips[0].outside_radius).toBe(false);
    expect(result.dayTrips[1].outside_radius).toBe(false);
  });
});

// ---------- KNOWN-NOT-HANDLED SCENARIOS ----------
// These tests document the system's CURRENT behavior in edge cases we
// haven't explicitly designed for. They're not "correct" or "incorrect",
// they pin the current behavior so a future regression is caught, and
// future-Ray can decide whether to fix the behavior or update the test
// when the limitations are addressed.

describe("real-world scenarios from production data", () => {
  test("multi-vehicle day (one driver, two units), verified happens in production (Dustin Marriott 2026-01-16 & 2026-04-02)", () => {
    // Real example: Dustin operated FDT14 and FDT15 on the same date.
    // dayCompliance includes ALL trips for the driver regardless of unit
    //, it doesn't distinguish. The compliance verdict is computed across
    // both units' activity combined.
    const start = [PPB.lat, PPB.lng];
    const site = nKmNorth(PPB, 30);
    const trips = [
      // FDT14 in the morning
      trip({ id: 1, driver: "dustin", unit: "FDT14", date: "2026-04-02", start_min: 7 * 60, end_min: 9 * 60, km: 30, startCoords: start, endCoords: site }),
      trip({ id: 2, driver: "dustin", unit: "FDT14", date: "2026-04-02", start_min: 9 * 60, end_min: 11 * 60, km: 30, startCoords: site, endCoords: start }),
      // FDT15 in the afternoon
      trip({ id: 3, driver: "dustin", unit: "FDT15", date: "2026-04-02", start_min: 13 * 60, end_min: 14 * 60, km: 30, startCoords: start, endCoords: site }),
      trip({ id: 4, driver: "dustin", unit: "FDT15", date: "2026-04-02", start_min: 14 * 60, end_min: 15 * 60, km: 30, startCoords: site, endCoords: start }),
    ];
    const result = dayCompliance("dustin", "2026-04-02", trips, []);
    expect(result.trips).toBe(4);  // both units' trips combined
    expect(result.state).toBe("exempt");  // all within radius, returned, short shift
  });

  test("Kyle Webber 2026-04-02 type day, 22+ trips totaling 1,455 km, pipeline handles high trip count", () => {
    // Real scenario from production: Kyle on FPT22, very high trip count.
    // dayCompliance is iterative; trip count alone shouldn't affect output.
    const start = [PPB.lat, PPB.lng];
    const trips = [];
    for (let i = 0; i < 22; i++) {
      const start_min = 7 * 60 + i * 20;     // 7am, 7:20, 7:40, ...
      const end_min = start_min + 15;
      trips.push(trip({
        id: i, start_min, end_min, km: 50,
        startCoords: i % 2 === 0 ? start : nKmNorth(PPB, 30),
        endCoords:   i % 2 === 0 ? nKmNorth(PPB, 30) : start,
      }));
    }
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.trips).toBe(22);
    expect(result.km).toBeGreaterThan(1000);
    expect(result.outside).toBe(false);  // all within 30 km of start
  });

  test("driver-attribution: trips with empty driver field are excluded (Norfab's missing-driver records)", () => {
    // 63% of production Titan records have an empty driver field, these
    // are real trips where someone moved a vehicle without logging in.
    // dayCompliance filters by `t.driver === driverId`; empty strings
    // don't match any real driver ID, so these records are silently dropped
    // from per-driver compliance evaluation.
    const start = [PPB.lat, PPB.lng];
    const trips = [
      trip({ id: 1, driver: "kyle", start_min: 9 * 60, end_min: 10 * 60, km: 20, startCoords: start, endCoords: start }),
      trip({ id: 2, driver: "",     start_min: 11 * 60, end_min: 12 * 60, km: 5,  startCoords: start, endCoords: start }),
    ];
    const result = dayCompliance("kyle", "2026-05-19", trips, []);
    expect(result.trips).toBe(1);  // only Kyle's trip, missing-driver trip excluded
  });
});

describe("known bugs (documented current behavior, fix candidates)", () => {
  test("BUG: midnight-crossing day under-reports shift hours (real case: Kyle Webber 2026-04-02)", () => {
    // Real Production Data: 22 trips, first starts 1:50 PM, last ends
    // 6:46 AM (next day). Titan tags both under tripDate=2026-04-02.
    //
    // CURRENT behavior: shiftMin = max(0, lastEnd - firstStart). When
    // lastEnd (~406 min, 6:46 AM) < firstStart (~830 min, 1:50 PM), the
    // subtraction is negative and clamps to 0. shift_hrs reports 0 for
    // what was actually a ~17 hour shift, and over_shift_limit is FALSE
    // even though it should be TRUE.
    //
    // The radius / return checks usually catch the day on other grounds,
    // but this is still a real bug, shift_hrs is the regulator-relevant
    // number, and a 0 reading is wrong.
    //
    // FUTURE FIX: if lastEnd < firstStart, infer the trip crossed midnight
    // and add 24h to lastEnd before computing shiftMin. Or detect and split
    // the day at tripDate boundaries.
    const start = [PPB.lat, PPB.lng];
    const farSite = nKmNorth(PPB, 200);
    const trips = [
      // First trip: 1:50 PM start, runs into evening, within radius
      trip({ id: 1, start_min: 13 * 60 + 50, end_min: 18 * 60, km: 50, startCoords: start, endCoords: farSite, date: "2026-04-02" }),
      // Last trip: end_min = 406 (6:46 AM next day, but Titan keeps date=2026-04-02)
      trip({ id: 2, start_min: 23 * 60, end_min: 6 * 60 + 46, km: 50, startCoords: farSite, endCoords: start, date: "2026-04-02" }),
    ];
    const result = dayCompliance("drv1", "2026-04-02", trips, []);
    // Pinning the buggy behavior, when this test starts failing, the bug got fixed
    expect(result.shift_hrs).toBe(0);  // SHOULD be ~17, currently 0 (bug)
    expect(result.over_shift_limit).toBe(false);  // SHOULD be true, currently false
    // The radius check still catches it though:
    expect(result.outside).toBe(true);
    expect(result.state).toBe("full-log");
  });
});

describe("documented current-behavior edge cases", () => {
  test("missing day-start coords (no GPS on first trip) → max_radius_km is 0, no outside", () => {
    // If we can't fix day-start coords, we can't measure radius. Current
    // behavior: treat radius as 0 (inside) but the day might still fail on
    // return-to-start or shift-limit.
    const trips = [
      trip({ start_min: 9 * 60, end_min: 10 * 60, km: 30, startCoords: null, endCoords: null }),
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.max_radius_km).toBe(0);
    expect(result.outside).toBe(false);
    expect(result.allReturned).toBe(false);  // can't verify return without coords
    expect(result.state).toBe("full-log");   // ...so day fails on condition (b)
  });
});

// ---------- DUTY SEGMENT BUILDER ----------

describe("buildSegmentsFromTrips (duty timeline)", () => {
  test("no trips → empty segments", () => {
    expect(buildSegmentsFromTrips([], null, null)).toEqual([]);
  });

  test("one trip 9-10am → segments cover full 24h: Off, Driving, Off", () => {
    const segs = buildSegmentsFromTrips(
      [{ start_min: 9 * 60, end_min: 10 * 60 }],
      null, null
    );
    // Total minutes should be 24*60 = 1440
    const total = segs.reduce((s, x) => s + (x.end - x.start), 0);
    expect(total).toBe(1440);
    // First segment should be Off (row=0) from midnight to 9am
    expect(segs[0]).toMatchObject({ start: 0, end: 540, row: 0 });
    // Then Driving (row=2)
    expect(segs.some(s => s.row === 2 && s.start === 540 && s.end === 600)).toBe(true);
    // Then Off again to end of day
    expect(segs[segs.length - 1].end).toBe(1440);
    expect(segs[segs.length - 1].row).toBe(0);
  });

  test("pre-trip before first drive adds on-duty bookend", () => {
    const segs = buildSegmentsFromTrips(
      [{ start_min: 9 * 60, end_min: 10 * 60 }],
      { time_min: 8 * 60 + 30 },  // pre-trip at 8:30
      null
    );
    // Should have an OnDuty (row=3) segment from 8:30 to 9:00
    expect(segs.some(s => s.row === 3 && s.start === 510 && s.end === 540)).toBe(true);
  });
});

// ---------- HOS SUBJECTIVITY GATE ----------
// Alberta HOS rules (AR 317/2002) only apply to commercial vehicles with
// GVW >= 11,794 kg, or truck/trailer combinations that hit that threshold.
// Light pickups under that weight aren't subject to the 160 km exemption
// test at all. The dashboard gates the test on the unit's class and the
// presence of a trailer on that day's DVI.

describe("HOS subjectivity gate", () => {
  test("light unit, no trailer, drove well past 160 km -> still exempt, no reasons", () => {
    const start = [PPB.lat, PPB.lng];
    const farSite = nKmNorth(PPB, 200);
    const trips = [
      trip({ unit: "FPT22", start_min: 7 * 60, end_min: 12 * 60, km: 200,
             startCoords: start, endCoords: farSite }),
      trip({ id: 2, unit: "FPT22", start_min: 12 * 60, end_min: 17 * 60, km: 200,
             startCoords: farSite, endCoords: start }),
    ];
    // Mark the unit as light (the dashboard adapter does this from the UNITS catalog).
    trips.forEach(t => { t.unit_class = "light"; });
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.subject_to_hos).toBe(false);
    expect(result.state).toBe("exempt");
    expect(result.reasons).toEqual([]);
    // The underlying measurements still record the truth, even though the
    // state is forced to exempt - so the day-detail view can show distance.
    expect(result.outside).toBe(true);
    expect(result.max_radius_km).toBeGreaterThan(RADIUS_LIMIT_KM);
  });

  test("light unit, no trailer, did not return to start -> still exempt, no reasons", () => {
    const start = [PPB.lat, PPB.lng];
    const elsewhere = nKmEast(PPB, 3);
    const trips = [
      trip({ unit: "FPT22", start_min: 7 * 60, end_min: 8 * 60, km: 3,
             startCoords: start, endCoords: elsewhere }),
    ];
    trips.forEach(t => { t.unit_class = "light"; });
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.subject_to_hos).toBe(false);
    expect(result.state).toBe("exempt");
    expect(result.reasons).toEqual([]);
    expect(result.allReturned).toBe(false);
  });

  test("light unit WITH a trailer on the pre-trip -> still subject, full-log if outside radius", () => {
    const start = [PPB.lat, PPB.lng];
    const farSite = nKmNorth(PPB, 200);
    const trips = [
      trip({ unit: "FPT22", start_min: 7 * 60, end_min: 12 * 60, km: 200,
             startCoords: start, endCoords: farSite }),
    ];
    trips.forEach(t => { t.unit_class = "light"; });
    const dvirs = [
      { ...dvir({ unit: "FPT22", trip_type: "Pre" }), trailer_unit: "TR42" },
    ];
    const result = dayCompliance("drv1", "2026-05-19", trips, dvirs);
    expect(result.subject_to_hos).toBe(true);
    expect(result.trailer_on_day).toBe(true);
    expect(result.state).toBe("full-log");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  test("heavy unit, no trailer, fails the exemption -> full-log as before (regression guard)", () => {
    const start = [PPB.lat, PPB.lng];
    const farSite = nKmNorth(PPB, 200);
    const trips = [
      trip({ unit: "FDT15", start_min: 7 * 60, end_min: 12 * 60, km: 200,
             startCoords: start, endCoords: farSite }),
    ];
    trips.forEach(t => { t.unit_class = "heavy"; });
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.subject_to_hos).toBe(true);
    expect(result.state).toBe("full-log");
  });

  test("unit_class missing on trip -> defaults to heavy (conservative)", () => {
    const start = [PPB.lat, PPB.lng];
    const farSite = nKmNorth(PPB, 200);
    const trips = [
      trip({ unit: "MYSTERY", start_min: 7 * 60, end_min: 12 * 60, km: 200,
             startCoords: start, endCoords: farSite }),
    ];
    // Note: do NOT set unit_class - simulating a trip from an unknown unit.
    const result = dayCompliance("drv1", "2026-05-19", trips, []);
    expect(result.subject_to_hos).toBe(true);
    expect(result.primary_unit_class).toBe("heavy");
    expect(result.state).toBe("full-log");
  });
});

// ---------- DAY-COMPLETE GATE FOR RETURN CHECK ----------
// Condition (b) of the 160 km exemption ("returned to day-start location at
// end of day") is an end-of-day determination. The dashboard must NOT flag
// a driver mid-shift just because they happen to be away from start
// (i.e. doing their job). Day is treated as complete when:
//   1. The calendar date is in the past
//   2. A post-trip DVI has been filed
//   3. Truck is currently at day-start AND has been idle >= 2 hours
// All scenarios below pin today_iso + now_ms in options so timing is
// deterministic regardless of when the test runs.

describe("day-complete gate for the return check", () => {
  // Helper: compute now_ms for "N minutes after a trip ending at end_min on dayISO"
  function nowMsAfterTripEnd(dayISO, end_min, idleMinutes) {
    return new Date(`${dayISO}T00:00:00`).getTime() + (end_min + idleMinutes) * 60 * 1000;
  }

  test("past date + did not return -> day_complete, flags full-log (regression guard)", () => {
    const start = [PPB.lat, PPB.lng];
    const customer = nKmEast(PPB, 5);
    const trips = [
      trip({ start_min: 8 * 60, end_min: 9 * 60, km: 5,
             startCoords: start, endCoords: customer }),
    ];
    // today_iso is much later -> past-date branch wins
    const result = dayCompliance("drv1", "2026-05-19", trips, [], { today_iso: "2026-06-01" });
    expect(result.day_complete).toBe(true);
    expect(result.allReturned).toBe(false);
    expect(result.state).toBe("full-log");
    expect(result.reasons.some(r => r.includes("did not return"))).toBe(true);
  });

  test("today + in-progress + not yet returned -> defers return check, state stays exempt", () => {
    const start = [PPB.lat, PPB.lng];
    const customer = nKmEast(PPB, 5);
    const trips = [
      trip({ date: "2026-05-22", start_min: 8 * 60, end_min: 9 * 60, km: 5,
             startCoords: start, endCoords: customer }),
    ];
    // 30 minutes after the trip ended, still today, no post-trip
    const result = dayCompliance("drv1", "2026-05-22", trips, [], {
      today_iso: "2026-05-22",
      now_ms: nowMsAfterTripEnd("2026-05-22", 9 * 60, 30),
    });
    expect(result.day_complete).toBe(false);
    expect(result.allReturned).toBe(false);
    expect(result.state).toBe("exempt");
    expect(result.reasons).toEqual([]);
  });

  test("today + at customer site + idle 4 hours -> still in-progress (away from start)", () => {
    // Driver dropped off at customer, working on-site for hours.
    // Must NOT auto-complete because the truck isn't at day-start.
    const start = [PPB.lat, PPB.lng];
    const customer = nKmEast(PPB, 5);
    const trips = [
      trip({ date: "2026-05-22", start_min: 8 * 60, end_min: 9 * 60, km: 5,
             startCoords: start, endCoords: customer }),
    ];
    const result = dayCompliance("drv1", "2026-05-22", trips, [], {
      today_iso: "2026-05-22",
      now_ms: nowMsAfterTripEnd("2026-05-22", 9 * 60, 240),  // 4h idle at customer
    });
    expect(result.day_complete).toBe(false);
    expect(result.state).toBe("exempt");
    expect(result.reasons).toEqual([]);
  });

  test("today + at day-start + idle 2.5 hours -> day_complete via idle-at-home clause", () => {
    // Driver finished early, parked at base, didn't file post-trip.
    // The dashboard recognises the day is effectively done.
    const start = [PPB.lat, PPB.lng];
    const trips = [
      trip({ date: "2026-05-22", start_min: 8 * 60, end_min:  9 * 60, km: 5,
             startCoords: start, endCoords: nKmEast(PPB, 5) }),
      trip({ id: 2, date: "2026-05-22", start_min: 14 * 60, end_min: 15 * 60, km: 5,
             startCoords: nKmEast(PPB, 5), endCoords: start }),  // back home at 3pm
    ];
    const result = dayCompliance("drv1", "2026-05-22", trips, [], {
      today_iso: "2026-05-22",
      now_ms: nowMsAfterTripEnd("2026-05-22", 15 * 60, 150),  // 2.5h idle at home
    });
    expect(result.day_complete).toBe(true);
    expect(result.allReturned).toBe(true);
    expect(result.state).toBe("exempt");
    expect(result.reasons).toEqual([]);
  });

  test("today + at day-start + idle only 30 min -> not yet complete", () => {
    const start = [PPB.lat, PPB.lng];
    const trips = [
      trip({ date: "2026-05-22", start_min: 8 * 60, end_min:  9 * 60, km: 5,
             startCoords: start, endCoords: nKmEast(PPB, 5) }),
      trip({ id: 2, date: "2026-05-22", start_min: 14 * 60, end_min: 15 * 60, km: 5,
             startCoords: nKmEast(PPB, 5), endCoords: start }),
    ];
    const result = dayCompliance("drv1", "2026-05-22", trips, [], {
      today_iso: "2026-05-22",
      now_ms: nowMsAfterTripEnd("2026-05-22", 15 * 60, 30),
    });
    expect(result.day_complete).toBe(false);
    // Result still "exempt" because allReturned=true, so the return clause
    // wouldn't fire either way. day_complete just affects the FAILURE branch.
    expect(result.state).toBe("exempt");
  });

  test("today + post-trip filed + did not return -> day_complete via post-trip, flags full-log", () => {
    const start = [PPB.lat, PPB.lng];
    const customer = nKmEast(PPB, 5);
    const trips = [
      trip({ date: "2026-05-22", start_min: 8 * 60, end_min: 9 * 60, km: 5,
             startCoords: start, endCoords: customer }),
    ];
    const dvirs = [
      dvir({ date_local: "2026-05-22", trip_type: "Pre",  time_min: 7 * 60 + 30 }),
      dvir({ date_local: "2026-05-22", trip_type: "Post", time_min: 17 * 60 }),
    ];
    const result = dayCompliance("drv1", "2026-05-22", trips, dvirs, {
      today_iso: "2026-05-22",
      now_ms: nowMsAfterTripEnd("2026-05-22", 9 * 60, 60),  // shortly after trip
    });
    expect(result.day_complete).toBe(true);
    expect(result.state).toBe("full-log");
    expect(result.reasons.some(r => r.includes("did not return"))).toBe(true);
  });

  test("today + outside 160 km radius + idle 30 min -> radius STILL flags real-time", () => {
    // Outside-radius is a real-time fact, NOT dependent on day_complete.
    // Day-complete gating applies only to the return check.
    const start = [PPB.lat, PPB.lng];
    const farSite = nKmNorth(PPB, 200);
    const trips = [
      trip({ date: "2026-05-22", start_min: 7 * 60, end_min: 12 * 60, km: 200,
             startCoords: start, endCoords: farSite }),
    ];
    const result = dayCompliance("drv1", "2026-05-22", trips, [], {
      today_iso: "2026-05-22",
      now_ms: nowMsAfterTripEnd("2026-05-22", 12 * 60, 30),
    });
    expect(result.day_complete).toBe(false);
    expect(result.outside).toBe(true);
    expect(result.state).toBe("full-log");
    expect(result.reasons.some(r => r.includes("outside"))).toBe(true);
    // Return clause must NOT be in the reasons because day isn't complete
    expect(result.reasons.some(r => r.includes("return"))).toBe(false);
  });
});
