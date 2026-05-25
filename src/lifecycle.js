const crypto = require('crypto');
const { LIFECYCLE_STATUSES, LC7_TAG_ID, P57_TAG_ID } = require('./config');
const { formatIST, isMoreThanDaysOld, parseDate, toIso } = require('./date-utils');

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

function findTriggeringMembers(rawCancellations, existingCycles, now = new Date()) {
    const existingCycleIds = new Set(existingCycles.map(cycle => cycle.cycleId));
    const grouped = new Map();

    for (const record of rawCancellations) {
        const memberId = getMemberId(record);
        const cancelledAt = parseDate(getCancellationDate(record) || record.cancelledDate);
        if (!memberId || !cancelledAt || !isUnlimitedMembership(record)) continue;

        if (!grouped.has(memberId)) grouped.set(memberId, []);
        grouped.get(memberId).push({ record, cancelledAt });
    }

    const detections = [];
    for (const [memberId, entries] of grouped.entries()) {
        entries.sort((a, b) => a.cancelledAt - b.cancelledAt);

        for (let i = 0; i < entries.length; i++) {
            const window = [];
            for (let j = i; j < entries.length; j++) {
                const spanDays = (entries[j].cancelledAt - entries[i].cancelledAt) / (1000 * 60 * 60 * 24);
                if (spanDays <= 7) window.push(entries[j]);
            }

            if (window.length >= 3) {
                const latest = window[window.length - 1];
                const cycleId = makeCycleId(memberId, latest.cancelledAt);
                if (!existingCycleIds.has(cycleId)) {
                    detections.push({
                        cycleId,
                        memberId,
                        memberName: latest.record.customerName || latest.record.memberName || '',
                        memberEmail: latest.record.customerEmail || latest.record.email || '',
                        latestLateCancellationAt: formatIST(latest.cancelledAt),
                        lc7TriggeredAt: formatIST(now),
                        p57EligibleAt: formatIST(new Date(latest.cancelledAt.getTime() + 7 * 24 * 60 * 60 * 1000)),
                        occurrenceCount: window.length,
                        status: LIFECYCLE_STATUSES.DETECTED,
                        lastError: '',
                        actionComment: `LC-7 initiated because member had ${window.length} unlimited membership late cancellations within ${((window[window.length - 1].cancelledAt - window[0].cancelledAt) / (1000 * 60 * 60 * 24)).toFixed(1)} days.`
                    });
                }
                break;
            }
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
    findTriggeringMembers,
    getCancellationDate,
    getMemberId,
    getMostRecentLateCancellationDate,
    isLateCancellation,
    makeCycleId,
    makeRawCancellationId,
    shouldTransitionToP57
};
