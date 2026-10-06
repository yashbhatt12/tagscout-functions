/**
 * TagScoutEdge — Cloud Functions
 *
 * alarmNotifier
 *   Trigger: a new document in /companies/{companyId}/tag_events/{eventId}
 *   Behaviour:
 *     - Look up the EPC in /companies/{companyId}/inventory_units/{epc}
 *     - If unknown OR status is "sold" → no alert
 *     - If status is "active" (unsold jewellery leaving the field) →
 *       write an alert to /companies/{companyId}/alerts/{alertId}
 *
 * The Android manager-view screen subscribes to the alerts collection
 * and surfaces unread alerts to the shop manager. The edge service
 * writes tag_events; this function derives business-meaningful alert
 * documents from them.
 */

import {setGlobalOptions} from "firebase-functions";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {initializeApp} from "firebase-admin/app";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

initializeApp({projectId: "tagscout-a0cc3"});
const db = getFirestore();

setGlobalOptions({maxInstances: 10, region: "asia-south1"});

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
    const epc: string | undefined = tagEvent.epc;
    if (!epc) {
      logger.warn("tag_event missing epc field", {companyId, eventId});
      return;
    }

    const itemRef = db
      .collection("companies").doc(companyId)
      .collection("inventory_units").doc(epc);
    const itemSnap = await itemRef.get();

    if (!itemSnap.exists) {
      logger.debug("Unknown EPC — ignoring", {companyId, epc});
      return;
    }

    const item = itemSnap.data()!;
    const status: string | undefined = item.status;

    if (status === "sold") {
      logger.debug("Sold item — no alert", {companyId, epc});
      return;
    }

    if (status !== "active") {
      logger.info("Non-active item seen at portal — not alerting", {
        companyId,
        epc,
        status,
      });
      return;
    }

    const alertDoc = {
      epc,
      itemCode: item.itemCode ?? null,
      category: item.category ?? null,
      price: item.price ?? null,
      readerId: tagEvent.readerId ?? null,
      antennaPort: tagEvent.antennaPort ?? null,
      rssi: tagEvent.rssi ?? null,
      firstSeenAt: tagEvent.firstSeenAt ?? null,
      sourceEventId: eventId,
      severity: "high",
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    };

    const alertRef = await db
      .collection("companies").doc(companyId)
      .collection("alerts")
      .add(alertDoc);

    logger.info("ALERT written", {
      companyId,
      alertId: alertRef.id,
      epc,
      itemCode: item.itemCode,
    });
  }
);
