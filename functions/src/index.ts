/**
 * TagScoutEdge — Cloud Functions
 *
 * alarmNotifier
 *   Trigger: a new document written to /companies/{companyId}/tag_events/{eventId}
 *   Behaviour:
 *     - Look up the EPC in /companies/{companyId}/inventory_units/{epc}
 *     - If the item is not registered (unknown EPC) OR its status is "sold" →
 *       no alert (expected traffic; nothing to notify about)
 *     - If the item status is "active" (unsold jewellery leaving the field) →
 *       write an alert to /companies/{companyId}/alerts/{alertId}
 *
 * The Android manager-view screen subscribes to the alerts collection and
 * surfaces unread alerts to the shop manager. The edge service writes
 * tag_events; this function derives the business-meaningful alert documents
 * from them. Separation of concerns:
 *   - edge: sensor
 *   - this function: notifier
 *   - app: UI
 */

import {setGlobalOptions} from "firebase-functions";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {initializeApp} from "firebase-admin/app";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

// Firebase Admin SDK must be initialised once per cold start.
initializeApp();
const db = getFirestore();

// Cost control — see firebase.json runtime config as well.
setGlobalOptions({maxInstances: 10, region: "asia-south1"});

/**
 * Fires on every new tag_event. The event path captures companyId and
 * eventId as wildcard params — same single function serves every tenant.
 */
export const alarmNotifier = onDocumentCreated(
    "companies/{companyId}/tag_events/{eventId}",
    async (event) => {
        const companyId = event.params.companyId;
        const eventId = event.params.eventId;

        const snap = event.data;
        if (!snap) {
            logger.warn("alarmNotifier fired with no snapshot", {companyId, eventId});
            return;
        }

        const tagEvent = snap.data();
        const epc: string | undefined = tagEvent.epc;
        if (!epc) {
            logger.warn("tag_event missing epc field", {companyId, eventId});
            return;
        }

        // Look up the item in inventory_units. Our schema uses the EPC as the
        // document id, so this is a direct get() — no query needed.
        const itemRef = db
            .collection("companies").doc(companyId)
            .collection("inventory_units").doc(epc);
        const itemSnap = await itemRef.get();

        if (!itemSnap.exists) {
            // Unknown EPC. Could be a non-jewellery tag (returned shipping label,
            // factory marker, something the customer brought in). Not an alarm.
            logger.debug("Unknown EPC — ignoring", {companyId, epc});
            return;
        }

        const item = itemSnap.data()!;
        const status: string | undefined = item.status;

        if (status === "sold") {
            // Expected — item was legitimately checked out. Edge service already
            // logged ✓ ALLOW. Nothing to notify.
            logger.debug("Sold item — no alert", {companyId, epc});
            return;
        }

        if (status !== "active") {
            // Items in other states (e.g. "pending", "damaged") shouldn't be in
            // the sales floor to begin with. Log but don't alert — this is a
            // workflow problem, not a theft problem.
            logger.info("Non-active item seen at portal — not alerting", {
                companyId, epc, status,
            });
            return;
        }

        // Active + seen at portal + not sold = alarm.
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