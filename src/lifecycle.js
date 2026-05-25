const crypto = require('crypto');
const { LIFECYCLE_STATUSES, LC7_TAG_ID, P57_TAG_ID } = require('./config');
const { formatIST, isMoreThanDaysOld, parseDate, toIso } = require('./date-utils');

const LC7_TRIGGER_CUTOFF_AT = new Date('2026-05-17T18:30:00.000Z');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function getCancellationDate(record) {
    return record.cancelledDate ??
        record.canceledDate ??
        record.cancelledAt ??
        record.canceledAt ??
        record.deletedAt ??
        record.lateCancelledAt ??
        record.lateCanceledAt ??
        record.lateCancellationDate ??
        record.lateCancellationAt;
}

function isLateCancellation(record) {
    if (!record) return false;
    if (record.isLateCancelled === true || record.isLateCancellation === true || record.lateCancellation === true) {
        return true;
    }

    const status = String(record.status || record.cancellationType || record.type || '').toLowerCase();
    return status.includes('late') && status.includes('cancel');
}

function getMostRecentLateCancellationDate(records) {
    const dates = records
        .filter(isLateCancellation)
        .map(getCancellationDate)
        .map(parseDate)
        .filter(Boolean)
        .sort((a, b) => b.getTime() - a.getTime());

    return dates[0] || null;
}

function getMemberId(record) {
    return Number(record.memberId || record.targetMemberId || record.customerId);
}

function getMembershipName(record) {
    return String(record.membershipName || '');
}

function isUnlimitedMembership(record) {
    return getMembershipName(record).toLowerCase().includes('unlimited');
}

function makeRawCancellationId(record) {
    const memberId = getMemberId(record);
    const cancelledDate = toIso(getCancellationDate(record) || record.cancelledDate);
    const sessionDate = toIso(record.sessionDate || record.startsAt);
    const bookingId = record.bookingId || record.sessionBookingId || '';
    return crypto
        .createHash('sha1')
        .update([memberId, cancelledDate, sessionDate, bookingId].join('|'))
        .digest('hex');
}

function makeCycleId(memberId, latestLateCancellationAt) {
    return crypto
        .createHash('sha1')
        .update(`${memberId}|${toIso(latestLateCancellationAt)}`)
        .digest('hex');
}

function getQualifyingEntries(rawCancellations, memberId = null) {
    return rawCancellations
        .map(record => ({
            record,
            memberId: getMemberId(record),
            cancelledAt: parseDate(getCancellationDate(record) || record.cancelledDate)
        }))
        .filter(entry =>
            entry.memberId &&
            entry.cancelledAt &&
            isUnlimitedMembership(entry.record) &&
            (memberId === null || entry.memberId === Number(memberId))
        )
        .sort((a, b) => a.cancelledAt - b.cancelledAt);
}

function findTriggerInEntries(entries, minimumTriggerDate = LC7_TRIGGER_CUTOFF_AT) {
    for (const candidate of entries) {
        if (candidate.cancelledAt < minimumTriggerDate) continue;

        const window = entries.filter(entry =>
            entry.cancelledAt <= candidate.cancelledAt &&
            candidate.cancelledAt - entry.cancelledAt <= SEVEN_DAYS_MS
        );

        if (window.length >= 3) {
            return {
                trigger: candidate,
                window: window.slice(0, 3)
            };
        }
    }

    return null;
}

function findLatestTriggerAfter(rawCancellations, memberId, afterDate) {
    const parsedAfterDate = parseDate(afterDate);
    if (!parsedAfterDate) return null;

    const entries = getQualifyingEntries(rawCancellations, memberId)
        .filter(entry => entry.cancelledAt > parsedAfterDate);
    let latestTrigger = null;

    for (let i = 0; i < entries.length; i++) {
        const subset = entries.slice(0, i + 1);
        const trigger = findTriggerInEntries(subset, parsedAfterDate);
        if (trigger) latestTrigger = trigger;
    }

    return latestTrigger;
}

function buildDetection(memberId, trigger, now) {
    const window = trigger.window;
    const latest = trigger.trigger;
    const spanDays = (window[window.length - 1].cancelledAt - window[0].cancelledAt) / (1000 * 60 * 60 * 24);

    return {
        cycleId: makeCycleId(memberId, latest.cancelledAt),
        memberId,
        memberName: latest.record.customerName || latest.record.memberName || '',
        memberEmail: latest.record.customerEmail || latest.record.email || '',
        latestLateCancellationAt: formatIST(latest.cancelledAt),
        lc7TriggeredAt: formatIST(now),
        p57EligibleAt: formatIST(new Date(latest.cancelledAt.getTime() + SEVEN_DAYS_MS)),
        occurrenceCount: window.length,
        status: LIFECYCLE_STATUSES.DETECTED,
        lastError: '',
        actionComment: `LC-7 initiated because member had ${window.length} unlimited membership late cancellations within ${spanDays.toFixed(1)} days. Trigger cancellation: ${formatIST(latest.cancelledAt)}.`
    };
}

function findTriggeringMembers(rawCancellations, existingCycles, now = new Date()) {
    const existingCycleIds = new Set(existingCycles.map(cycle => cycle.cycleId));
    const activeMemberIds = new Set(
        existingCycles
            .filter(cycle => cycle.status !== LIFECYCLE_STATUSES.P57_TAG_ASSIGNED && cycle.status !== LIFECYCLE_STATUSES.FAILED)
            .map(cycle => Number(cycle.memberId))
            .filter(Boolean)
    );
    const grouped = new Map();

    for (const entry of getQualifyingEntries(rawCancellations)) {
        if (activeMemberIds.has(entry.memberId)) continue;

        if (!grouped.has(entry.memberId)) grouped.set(entry.memberId, []);
        grouped.get(entry.memberId).push(entry);
    }

    const detections = [];
    for (const [memberId, entries] of grouped.entries()) {
        const trigger = findTriggerInEntries(entries);
        if (!trigger) continue;

        const detection = buildDetection(memberId, trigger, now);
        if (!existingCycleIds.has(detection.cycleId)) {
            detections.push(detection);
        }
    }

    return detections;
}

function buildP57TagPayload(currentTags, memberId) {
    const tagIds = [];
    for (const tag of currentTags) {
        const tagId = Number(tag.id ?? tag.tagId ?? tag.tag?.id);
        if (!tagId || tagId === LC7_TAG_ID || tagId === P57_TAG_ID) continue;
        if (!tagIds.includes(tagId)) tagIds.push(tagId);
    }
    tagIds.push(P57_TAG_ID);
    return {
        tagIds,
        type: 'customer',
        entityId: Number(memberId)
    };
}

function shouldTransitionToP57(cycle, currentTags, now = new Date()) {
    const hasLc7 = currentTags.some(tag => Number(tag.id ?? tag.tagId ?? tag.tag?.id) === LC7_TAG_ID);
    if (!hasLc7) {
        return { shouldTransition: false, reason: 'LC-7 tag is not present' };
    }

    if (!isMoreThanDaysOld(cycle.latestLateCancellationAt, 7, now)) {
        return { shouldTransition: false, reason: 'Latest late cancellation is not more than 7 days old' };
    }

    return { shouldTransition: true, reason: 'Latest late cancellation is more than 7 days old' };
}

module.exports = {
    buildP57TagPayload,
    findLatestTriggerAfter,
    findTriggeringMembers,
    getCancellationDate,
    getMemberId,
    getMostRecentLateCancellationDate,
    isLateCancellation,
    makeCycleId,
    makeRawCancellationId,
    shouldTransitionToP57
};
