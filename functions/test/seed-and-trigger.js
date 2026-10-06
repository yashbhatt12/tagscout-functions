/**
 * TagScoutEdge — Cloud Functions local test harness
 *
 * Seeds inventory_units and writes tag_events against the Firestore
 * emulator, which triggers the alarmNotifier Cloud Function running
 * in the Functions emulator.
 *
 * Expectations (watch the emulator terminal):
 *   Scenario 1  active item   → ALERT written
 *   Scenario 2  sold item     → no alert ("Sold item — no alert")
 *   Scenario 3  unknown EPC   → no alert ("Unknown EPC — ignoring")
 *
 * Run from the functions/ directory:
 *   node test/seed-and-trigger.js
 */

const admin = require("firebase-admin");

// Point Admin SDK at the local Firestore emulator.
// Without this, writes would hit the real tagscout-a0cc3 project.
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

admin.initializeApp({projectId: "tagscout-a0cc3"});
const db = admin.firestore();

const COMPANY_ID = "test-company";

async function run() {
  console.log(`\nSeeding against emulator at ${process.env.FIRESTORE_EMULATOR_HOST}\n`);

  // ─── Scenario 1: active (unsold) item ────────────────────────────
  const activeEpc = "TEST-EPC-001";
  await db.collection("companies").doc(COMPANY_ID)
    .collection("inventory_units").doc(activeEpc)
    .set({
      epc: activeEpc,
      itemCode: "RING-001",
      category: "rings",
      price: 50000,
      status: "active",
    });
  console.log(`✓ seeded inventory_unit ${activeEpc} (status=active)`);

  // ─── Scenario 2: sold item ───────────────────────────────────────
  const soldEpc = "TEST-EPC-002";
  await db.collection("companies").doc(COMPANY_ID)
    .collection("inventory_units").doc(soldEpc)
    .set({
      epc: soldEpc,
      itemCode: "RING-002",
      category: "rings",
      price: 75000,
      status: "sold",
      soldAt: Date.now(),
      soldBy: "test-counter-1",
    });
  console.log(`✓ seeded inventory_unit ${soldEpc} (status=sold)`);

  // ─── Fire tag_events — these trigger alarmNotifier ───────────────
  // Small pause so the seeds settle before triggering reads.
  await new Promise((r) => setTimeout(r, 500));

  console.log("\nFiring tag_events (watch the emulator terminal for function logs):\n");

  // 1. Active item passes portal → expect ALERT
  await writeTagEvent(activeEpc, "scenario 1 (active) — expect ALERT");

  // 2. Sold item passes portal → expect NO alert
  await writeTagEvent(soldEpc, "scenario 2 (sold)   — expect no alert");

  // 3. Unknown EPC passes portal → expect NO alert
  await writeTagEvent("TEST-EPC-UNKNOWN", "scenario 3 (unknown) — expect no alert");

  // Small pause so the function has time to log before Admin shuts down.
  await new Promise((r) => setTimeout(r, 1500));

  console.log("\nDone. Check:");
  console.log("  1. Emulator terminal for function logs");
  console.log("  2. http://127.0.0.1:4000/firestore → companies/test-company/alerts");
  console.log("     should contain exactly 1 document (for TEST-EPC-001)\n");
}

async function writeTagEvent(epc, label) {
  await db.collection("companies").doc(COMPANY_ID)
    .collection("tag_events")
    .add({
      epc: epc,
      antennaPort: 1,
      rssi: -57,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      dwellMillis: 1200,
      rawReadCount: 42,
      readerId: "fr901-main-exit",
    });
  console.log(`→ wrote tag_event for ${epc}  (${label})`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
