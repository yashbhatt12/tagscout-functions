/**
 * TagScoutEdge — Cloud Functions
 *
 * alarmNotifier
 *   Trigger: a new document in /companies/{companyId}/tag_events/{eventId}
 *   Behaviour:
 *     - Look up the EPC in /companies/{companyId}/inventory_units/{epc}
 *     - Unknown EPC, or a unit that is sold or otherwise allowed out → no alert
 *     - Unit still counted as stock (in_stock, picked) → it is leaving
 *       unpaid: write an alert to /companies/{companyId}/alerts/{alertId}
 *
 * The Android manager-view screen and the web dashboard subscribe to the
 * alerts collection and surface unread alerts to the shop manager. The edge
 * service writes tag_events; this function derives alert documents from them.
 */

import {setGlobalOptions} from "firebase-functions";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {initializeApp} from "firebase-admin/app";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

// No projectId: use whichever project the function is deployed to.
initializeApp();
const db = getFirestore();

setGlobalOptions({maxInstances: 10, region: "asia-south1"});

/**
 * Unit statuses that mean "still stock, should not be leaving".
 * Same as STOCK_STATUSES in the app's InventoryRepository.
 */
const ALERT_STATUSES = new Set(["in_stock", "picked"]);

/**
 * Reads a string field, or null when it is missing or not a string.
 * @param {unknown} value The raw Firestore value.
 * @return {string | null} The string, or null.
 */
function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export const alarmNotifier = onDocumentCreated(
  "companies/{companyId}/tag_events/{eventId}",
  async (event) => {
    const companyId = event.params.companyId;
    const eventId = event.params.eventId;

    const snap = event.data;
    if (!snap) {
      logger.warn("alarmNotifier fired with no snapshot", {
        companyId,
        eventId,
      });
      return;
    }

    const tagEvent = snap.data();
    const rawEpc = text(tagEvent.epc);
    if (!rawEpc) {
      logger.warn("tag_event missing epc field", {companyId, eventId});
      return;
    }
    // Unit document IDs are uppercase hex EPCs.
    const epc = rawEpc.trim().toUpperCase();

    const company = db.collection("companies").doc(companyId);
    const itemSnap = await company.collection("inventory_units").doc(epc).get();

    if (!itemSnap.exists) {
      logger.debug("Unknown EPC — ignoring", {companyId, epc});
      return;
    }

    const item = itemSnap.data() ?? {};
    const status = text(item.status) ?? "in_stock";

    if (!ALERT_STATUSES.has(status)) {
      logger.debug("Unit is not stock — no alert", {companyId, epc, status});
      return;
    }

    // Product name and category, for a readable alert.
    const productId = text(item.productId);
    let productTitle: string | null = null;
    let categoryName: string | null = null;
    if (productId) {
      const product = await company.collection("products").doc(productId).get();
      productTitle = text(product.get("title"));
      const categoryId = text(product.get("categoryId"));
      if (categoryId) {
        const category = await company.collection("categories")
          .doc(categoryId).get();
        categoryName = text(category.get("name"));
      }
    }

    const alertDoc = {
      epc,
      // itemCode and category are what the app's alert screen shows.
      itemCode: text(item.sku) ?? text(item.itemCode),
      category: categoryName ?? productTitle ?? text(item.category),
      productId,
      productTitle,
      price: typeof item.price === "number" ? item.price : null,
      unitStatus: status,
      readerId: tagEvent.readerId ?? null,
      antennaPort: tagEvent.antennaPort ?? null,
      rssi: tagEvent.rssi ?? null,
      firstSeenAt: tagEvent.firstSeenAt ?? null,
      sourceEventId: eventId,
      severity: "high",
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    };

    const alertRef = await company.collection("alerts").add(alertDoc);

    logger.info("ALERT written", {
      companyId,
      alertId: alertRef.id,
      epc,
      sku: alertDoc.itemCode,
    });
  }
);
