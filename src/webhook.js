const crypto = require('crypto');
const { LIFECYCLE_STATUSES } = require('./config');
const { formatIST, formatRunTimestamp, parseDate } = require('./date-utils');
const {
    findTriggeringMembers,
    getCancellationDate,
    getMemberId,
    isUnlimitedMembership
} = require('./lifecycle');
const { extractMembershipName } = require('./momence-v2');

const CANCELLED_EVENT_NAMES = new Set(['session-booking-cancelled', 'session.booking.cancelled', 'session_booking_cancelled']);

function safeEqual(a, b) {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Momence sends {"payload": "<JSON string>"}; the signature is an HMAC-SHA256 of that
// string. Docs don't state the digest encoding, so hex and base64 are both accepted.
function verifyWebhook({ headers, rawBody, secret, enforceSignature }) {
    if (!secret) return { ok: false, status: 500, reason: 'MOMENCE_WEBHOOK_SECRET not configured' };

    let body;
    try {
        body = JSON.parse(rawBody);
    } catch {
        return { ok: false, status: 400, reason: 'Body is not JSON' };
    }
    const payloadString = typeof body?.payload === 'string' ? body.payload : null;
    if (!payloadString) return { ok: false, status: 400, reason: 'Missing payload string' };

    if (!safeEqual(headers['x-webhook-secret'], secret)) {
        return { ok: false, status: 401, reason: 'Invalid x-webhook-secret' };
    }

    const signature = String(headers['x-webhook-signature'] || '').trim();
    const hmac = crypto.createHmac('sha256', secret).update(payloadString);
    const digest = hmac.digest();
    const signatureValid = Boolean(signature) &&
        (safeEqual(signature.toLowerCase(), digest.toString('hex')) || safeEqual(signature, digest.toString('base64')));
    if (!signatureValid) {
        if (enforceSignature) return { ok: false, status: 401, reason: 'Invalid x-webhook-signature' };
        console.warn('Webhook signature missing or did not match (secret header was valid); accepting. Set MOMENCE_WEBHOOK_ENFORCE_SIGNATURE=true once confirmed.');
    }

    let envelope;
    try {
        envelope = JSON.parse(payloadString);
    } catch {
        return { ok: false, status: 400, reason: 'payload is not valid JSON' };
    }

    return {
        ok: true,
        status: 200,
        requestId: headers['x-webhook-reqeuest-id'] || headers['x-webhook-request-id'] || '',
        signatureValid,
        event: envelope?.event || '',
        timestamp: envelope?.timestamp || '',
        payload: envelope?.payload || {}
    };
}

function isLateCancellationEvent(verified) {
    return CANCELLED_EVENT_NAMES.has(String(verified.event)) && verified.payload?.isLateCancellation === true;
}

function sessionKey(record) {
    const sessionAt = parseDate(record.sessionDate || record.startsAt);
    return sessionAt ? `${getMemberId(record)}|s|${Math.round(sessionAt.getTime() / 60000)}` : null;
}

function cancelKey(record) {
    const cancelledAt = parseDate(getCancellationDate(record) || record.cancelledDate);
    return cancelledAt ? `${getMemberId(record)}|c|${Math.round(cancelledAt.getTime() / 60000)}` : null;
}

// Same late cancellation can be stored twice (webhook row + hourly report row).
function dedupeCancellations(records) {
    const seen = new Set();
    const result = [];
    for (const record of records) {
        const keys = [sessionKey(record), cancelKey(record)].filter(Boolean);
        if (keys.some(key => seen.has(key))) continue;
        keys.forEach(key => seen.add(key));
        result.push(record);
    }
    return result;
}

function rawRowToRecord(row) {
    return {
        memberId: Number(row.memberId),
        customerName: row.memberName,
        customerEmail: row.memberEmail,
        cancelledEvent: row.cancelledEvent,
        cancelledDate: row.cancelledAt,
        sessionDate: row.sessionAt,
        membershipName: row.membershipName,
        homeLocation: row.homeLocation
    };
}

// Private Momence customer history (readonly-api .../customers/{id}/history). Items of
// type 'session' carry bookingId/sessionId and the membership used to pay.
function findHistoryBooking(history, sessionBookingId, sessionId) {
    const items = Array.isArray(history) ? history : (history?.payload || history?.items || []);
    const sessions = items.filter(item => !item?.type || item.type === 'session');
    return sessions.find(item => sessionBookingId && Number(item.bookingId ?? item.sessionBookingId ?? item.id) === Number(sessionBookingId)) ||
        sessions.find(item => sessionId && Number(item.sessionId ?? item.session?.id) === Number(sessionId)) ||
        null;
}

async function findMembershipInReport(momence, memberId, cancelledAt, sessionStartsAt) {
    const records = await momence.fetchLateCancellations(14);
    const cancelTime = parseDate(cancelledAt)?.getTime();
    const sessionTime = parseDate(sessionStartsAt)?.getTime();
    const match = records.find(record => {
        if (getMemberId(record) !== Number(memberId)) return false;
        const recordSession = parseDate(record.sessionDate || record.startsAt)?.getTime();
        const recordCancel = parseDate(getCancellationDate(record) || record.cancelledDate)?.getTime();
        return (sessionTime && recordSession && Math.abs(recordSession - sessionTime) < 60000) ||
            (cancelTime && recordCancel && Math.abs(recordCancel - cancelTime) < 5 * 60000);
    });
    return match ? String(match.membershipName || '') : '';
}

// Handle one verified late-cancellation webhook. deps: { store, momence, momenceV2,
// emailService, config, run helpers }. Uses the exact same detection rules as the
// scheduled run (findTriggeringMembers), over this member's stored late cancellations.
async function processLateCancellation(verified, deps, now = new Date()) {
    const { store, momence, momenceV2, emailService, config, helpers } = deps;
    const payload = verified.payload;
    const memberId = Number(payload.targetMemberId || payload.payingMemberId);
    const result = { memberId, sessionBookingId: payload.sessionBookingId, outcome: '', cyclesCreated: 0, lc7Assigned: 0, bookingsCancelled: 0, emailsSent: 0, failedCount: 0 };

    if (!memberId) return { ...result, outcome: 'SKIPPED_NO_MEMBER' };
    if (config.testMemberId && memberId !== config.testMemberId) return { ...result, outcome: 'SKIPPED_TEST_MEMBER_FILTER' };

    // 1. Member details
    let member = null;
    try {
        member = await momenceV2.getMember(memberId);
    } catch (error) {
        console.warn(`Webhook: member ${memberId} lookup failed: ${error.response?.status || error.message}`);
    }

    // 2. The cancelled booking, from the member's session bookings
    let booking = null;
    try {
        booking = await momenceV2.findMemberBooking(memberId, payload.sessionBookingId, payload.cancelledAt);
    } catch (error) {
        console.warn(`Webhook: bookings lookup for member ${memberId} failed: ${error.response?.status || error.message}`);
    }

    // 3. Membership used for that booking: private customer history first, then the
    //    v2 booking object, then the late-cancellation report.
    let historyItem = null;
    try {
        historyItem = findHistoryBooking(await momence.fetchMemberHistory(memberId), payload.sessionBookingId, payload.sessionId);
    } catch (error) {
        console.warn(`Webhook: history lookup for member ${memberId} failed: ${error.response?.status || error.message}`);
    }
    let membershipName = extractMembershipName(historyItem);
    let membershipSource = membershipName ? 'customer-history' : '';
    if (!membershipName) {
        membershipName = extractMembershipName(booking);
        if (membershipName) membershipSource = 'session-bookings';
    }
    if (!membershipName) {
        try {
            membershipName = await findMembershipInReport(momence, memberId, payload.cancelledAt, booking?.session?.startsAt || historyItem?.startsAt);
            if (membershipName) membershipSource = 'late-cancellation-report';
        } catch (error) {
            console.warn(`Webhook: report fallback for member ${memberId} failed: ${error.response?.status || error.message}`);
        }
    }

    const record = {
        memberId,
        customerName: [member?.firstName, member?.lastName].filter(Boolean).join(' '),
        customerEmail: member?.email || '',
        cancelledEvent: booking?.session?.name || historyItem?.sessionName || historyItem?.name || historyItem?.title || '',
        cancelledDate: payload.cancelledAt,
        sessionDate: booking?.session?.startsAt || historyItem?.startsAt || '',
        membershipName,
        bookingId: payload.sessionBookingId
    };

    // 4. Store the raw late cancellation (idempotent by rawId)
    const [rawRow] = helpers.mapRawCancellationRows([record]);
    if (rawRow) {
        rawRow.comment = `Momence webhook late cancellation. Member ${memberId} cancelled ${record.cancelledEvent || 'a session'} (booking ${payload.sessionBookingId}). Membership: ${membershipName || 'UNKNOWN'}${membershipSource ? ` via ${membershipSource}` : ''}.`;
        await store.insertRawRows([rawRow]);
    }

    if (!membershipName) return { ...result, outcome: 'MEMBERSHIP_UNKNOWN_DEFERRED_TO_SCHEDULED_RUN' };
    if (!isUnlimitedMembership(record)) return { ...result, outcome: 'NOT_UNLIMITED_MEMBERSHIP' };

    // 5. This member's late-cancellation history, same lookback as the scheduled run
    const lookbackDays = Math.max(config.reportLookbackDays || 30, 14);
    const since = now.getTime() - lookbackDays * 86400000;
    const history = dedupeCancellations([
        record,
        ...(await store.getRawRows())
            .filter(row => Number(row.memberId) === memberId)
            .map(rawRowToRecord)
    ]).filter(item => {
        const cancelledAt = parseDate(getCancellationDate(item) || item.cancelledDate);
        return cancelledAt && cancelledAt.getTime() >= since;
    });

    const lifecycleRows = await store.getLifecycleRows();
    const memberCycles = lifecycleRows.filter(cycle => Number(cycle.memberId) === memberId);

    // 6a. Already serving LC-7: reset the 7-day clock if a new 3-in-7 trigger exists
    const waiting = memberCycles.filter(cycle => cycle.status === LIFECYCLE_STATUSES.WAITING_7_DAYS);
    if (waiting.length > 0) {
        const { refreshedCount } = await helpers.refreshWaitingCycleTriggerDates(store, history, waiting);
        return { ...result, outcome: refreshedCount > 0 ? 'WAITING_PERIOD_RESET' : 'ALREADY_IN_LC7' };
    }

    // 6b. New trigger? (3 unlimited late cancellations within 7 days)
    const detections = findTriggeringMembers(history, lifecycleRows, now, console.warn)
        .filter(detection => Number(detection.memberId) === memberId);
    if (detections.length === 0) {
        const unlimitedCount = history.filter(isUnlimitedMembership).length;
        return { ...result, outcome: `BELOW_THRESHOLD (${unlimitedCount} unlimited late cancellation(s) in lookback)` };
    }

    // 7. Apply LC-7 exactly like the scheduled run
    result.cyclesCreated = await store.insertLifecycleRows(detections);
    const { assigned, failedCount: tagFailures } = await helpers.assignLc7ForNewCycles(store, momence, detections);
    result.lc7Assigned = assigned.length;
    result.failedCount += tagFailures;
    const { completedCycles, totalCancelled, failedCount: cancelFailures } = await helpers.cancelBookingsForAssignedCycles(store, momence, assigned);
    result.bookingsCancelled = totalCancelled;
    result.failedCount += cancelFailures;
    const emails = await helpers.sendLifecycleEmails(store, emailService, completedCycles, 'A');
    result.emailsSent = emails.sent;
    result.failedCount += emails.failed;

    return { ...result, outcome: result.failedCount > 0 ? 'LC7_TRIGGERED_WITH_FAILURES' : 'LC7_TRIGGERED' };
}

function buildWebhookRunLog(verified, result, startedAt, error = null) {
    return {
        runId: `webhook:${verified.requestId || crypto.randomUUID()}`,
        startedAt,
        finishedAt: formatRunTimestamp(),
        rawRecordsFetched: 1,
        rawRecordsInserted: 0,
        cyclesCreated: result?.cyclesCreated || 0,
        lc7Assigned: result?.lc7Assigned || 0,
        bookingsCancelled: result?.bookingsCancelled || 0,
        p57Assigned: 0,
        retriedCount: 0,
        missedAssignmentsDetected: 0,
        skippedRecords: 0,
        failedCount: (result?.failedCount || 0) + (error ? 1 : 0),
        emailsSent: result?.emailsSent || 0,
        emailsFailed: 0,
        failedMemberIds: error || result?.failedCount ? String(verified.payload?.targetMemberId || '') : '',
        status: error ? 'FAILED' : 'COMPLETED',
        message: error
            ? `Webhook ${verified.event} booking ${verified.payload?.sessionBookingId}: ${error.stack || error.message}`
            : `Webhook ${verified.event} member ${result.memberId} booking ${result.sessionBookingId} cancelled ${formatIST(verified.payload?.cancelledAt)}: ${result.outcome}`
    };
}

module.exports = {
    buildWebhookRunLog,
    dedupeCancellations,
    findHistoryBooking,
    isLateCancellationEvent,
    processLateCancellation,
    rawRowToRecord,
    verifyWebhook
};
