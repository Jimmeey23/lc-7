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

function getQualifyingEntries(rawCancellations, memberId = null, logger = null) {
    const results = [];
    for (const record of rawCancellations) {
        const id = getMemberId(record);
        if (!id || Number.isNaN(id)) {
            logger?.(`SKIP: missing memberId for customerName=${record.customerName || 'unknown'}`);
            continue;
        }
        const cancelledAt = parseDate(getCancellationDate(record) || record.cancelledDate);
        if (!cancelledAt) {
            logger?.(`SKIP: unparseable cancellation date for memberId=${id}, raw=${getCancellationDate(record)}`);
            continue;
        }
        if (!isUnlimitedMembership(record)) continue;
        if (memberId !== null && id !== Number(memberId)) continue;
        results.push({ record, memberId: id, cancelledAt });
    }
    return results.sort((a, b) => a.cancelledAt - b.cancelledAt);
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

function findLatestTriggerInEntriesAfter(entries, afterDate) {
    const parsedAfterDate = parseDate(afterDate);
    if (!parsedAfterDate) return null;

    const newerEntries = entries.filter(entry => entry.cancelledAt > parsedAfterDate);
    let latestTrigger = null;

    for (let i = 0; i < newerEntries.length; i++) {
        const subset = newerEntries.slice(0, i + 1);
        const trigger = findTriggerInEntries(subset, parsedAfterDate);
        if (trigger) latestTrigger = trigger;
    }

    return latestTrigger;
}

function findLatestTriggerAfter(rawCancellations, memberId, afterDate) {
    const parsedAfterDate = parseDate(afterDate);
    if (!parsedAfterDate) return null;

    return findLatestTriggerInEntriesAfter(getQualifyingEntries(rawCancellations, memberId), parsedAfterDate);
}

function buildDetection(memberId, trigger, now) {
    const window = trigger.window;
    const latest = trigger.trigger;
    const spanDays = (window[window.length - 1].cancelledAt - window[0].cancelledAt) / (1000 * 60 * 60 * 24);
    const windowDates = window.map(entry => formatIST(entry.cancelledAt));

    return {
        cycleId: makeCycleId(memberId, latest.cancelledAt),
        memberId,
        memberName: latest.record.customerName || latest.record.memberName || '',
        memberEmail: latest.record.customerEmail || latest.record.email || '',
        latestLateCancellationAt: formatIST(latest.cancelledAt),
        p57EligibleAt: formatIST(new Date(latest.cancelledAt.getTime() + SEVEN_DAYS_MS)),
        occurrenceCount: window.length,
        retryCount: 0,
        status: LIFECYCLE_STATUSES.DETECTED,
        assignmentReason: `3 late cancellations in 7-day window: ${windowDates.join(', ')}`,
        lastError: '',
        actionComment: `LC-7 initiated: ${window.length} unlimited membership late cancellations within ${spanDays.toFixed(1)} days. Trigger: ${formatIST(latest.cancelledAt)}.`
    };
}

function isManualOverrideCycle(cycle) {
    const text = `${cycle.assignmentReason || ''} ${cycle.actionComment || ''}`;
    return text.includes('Manual OVERRIDE');
}

function getCompletedCycleRestartAfterByMemberId(existingCycles) {
    const completedCycleRestartAfterByMemberId = new Map();

    for (const cycle of existingCycles) {
        if (cycle.status !== LIFECYCLE_STATUSES.P57_TAG_ASSIGNED) continue;

        const memberId = Number(cycle.memberId);
        const restartAfter = isManualOverrideCycle(cycle)
            ? parseDate(cycle.latestLateCancellationAt) || parseDate(cycle.p57TagAssignedAt)
            : parseDate(cycle.p57TagAssignedAt) || parseDate(cycle.latestLateCancellationAt);
        if (!memberId || !restartAfter) continue;

        const existingRestartAfter = completedCycleRestartAfterByMemberId.get(memberId);
        if (!existingRestartAfter || restartAfter > existingRestartAfter) {
            completedCycleRestartAfterByMemberId.set(memberId, restartAfter);
        }
    }

    return completedCycleRestartAfterByMemberId;
}

function findTriggeringMembers(rawCancellations, existingCycles, now = new Date(), logger = null) {
    const existingCycleIds = new Set(existingCycles.map(cycle => cycle.cycleId));
    const activeMemberIds = new Set(
        existingCycles
            .filter(cycle => cycle.status !== LIFECYCLE_STATUSES.P57_TAG_ASSIGNED && cycle.status !== LIFECYCLE_STATUSES.FAILED)
            .map(cycle => Number(cycle.memberId))
            .filter(Boolean)
    );
    const completedCycleRestartAfterByMemberId = getCompletedCycleRestartAfterByMemberId(existingCycles);
    const grouped = new Map();

    for (const entry of getQualifyingEntries(rawCancellations, null, logger)) {
        if (activeMemberIds.has(entry.memberId)) continue;

        if (!grouped.has(entry.memberId)) grouped.set(entry.memberId, []);
        grouped.get(entry.memberId).push(entry);
    }

    const detections = [];
    for (const [memberId, entries] of grouped.entries()) {
        const restartAfter = completedCycleRestartAfterByMemberId.get(memberId);
        const trigger = restartAfter
            ? findLatestTriggerInEntriesAfter(entries, restartAfter)
            : findTriggerInEntries(entries);
        if (!trigger) continue;

        const detection = buildDetection(memberId, trigger, now);
        if (!existingCycleIds.has(detection.cycleId)) {
            detections.push(detection);
        }
    }

    return detections;
}

function detectMissedAssignments(rawCancellations, allCycles, now = new Date()) {
    // Members with any existing cycle (any status) are excluded — they're already tracked
    const memberIdsWithCycle = new Set(
        allCycles.map(cycle => Number(cycle.memberId)).filter(Boolean)
    );

    const entries = getQualifyingEntries(rawCancellations);
    const grouped = new Map();
    for (const entry of entries) {
        if (memberIdsWithCycle.has(entry.memberId)) continue;
        if (!grouped.has(entry.memberId)) grouped.set(entry.memberId, []);
        grouped.get(entry.memberId).push(entry);
    }

    const missed = [];
    for (const [memberId, memberEntries] of grouped.entries()) {
        const trigger = findTriggerInEntries(memberEntries);
        if (!trigger) continue;

        const latest = trigger.trigger;
        const p57EligibleAt = new Date(latest.cancelledAt.getTime() + SEVEN_DAYS_MS);
        const isExpired = p57EligibleAt <= now;
        const detection = buildDetection(memberId, trigger, now);

        if (isExpired) {
            missed.push({
                ...detection,
                status: LIFECYCLE_STATUSES.P57_TAG_ASSIGNED,
                lc7TagAssignedAt: '',
                p57TagAssignedAt: formatIST(now),
                assignmentReason: `Backdated — penalty period already expired at ${formatIST(p57EligibleAt)}. Trigger: ${formatIST(latest.cancelledAt)}. No LC-7 tag assigned. Cycle closed.`,
                actionComment: `Missed assignment detected retroactively. Penalty period expired without enforcement. Cycle closed.`,
                isBackdated: true,
                isExpired: true
            });
        } else {
            missed.push({
                ...detection,
                status: LIFECYCLE_STATUSES.DETECTED,
                assignmentReason: `Backdated — missed assignment. Trigger: ${formatIST(latest.cancelledAt)}. LC-7 to be assigned silently. Removal scheduled for ${formatIST(p57EligibleAt)}.`,
                actionComment: `Missed LC-7 assignment detected. Assigning tag silently — no email notification.`,
                isBackdated: true,
                isExpired: false
            });
        }
    }

    return missed;
}

function buildAtRiskRows(rawCancellations, activeMemberIds = new Set(), now = new Date(), existingCycles = []) {
    const sevenDaysAgo = new Date(now.getTime() - SEVEN_DAYS_MS);
    const restartAfterByMemberId = getCompletedCycleRestartAfterByMemberId(existingCycles);
    const grouped = new Map();

    for (const entry of getQualifyingEntries(rawCancellations)) {
        if (activeMemberIds.has(entry.memberId)) continue;
        const restartAfter = restartAfterByMemberId.get(entry.memberId);
        if (restartAfter && entry.cancelledAt <= restartAfter) continue;
        if (entry.cancelledAt < sevenDaysAgo) continue;
        if (!grouped.has(entry.memberId)) grouped.set(entry.memberId, []);
        grouped.get(entry.memberId).push(entry);
    }

    const rows = [];
    for (const [memberId, entries] of grouped.entries()) {
        if (entries.length >= 3) continue; // triggers LC-7, not at-risk
        const sorted = [...entries].sort((a, b) => a.cancelledAt - b.cancelledAt);
        const latest = sorted[sorted.length - 1];
        rows.push({
            memberId,
            memberName: latest.record.customerName || latest.record.memberName || '',
            memberEmail: latest.record.customerEmail || latest.record.email || '',
            cancellationsInWindow: entries.length,
            oldestCancellationInWindow: formatIST(sorted[0].cancelledAt),
            latestCancellationAt: formatIST(latest.cancelledAt),
            windowExpiresAt: formatIST(new Date(sorted[0].cancelledAt.getTime() + SEVEN_DAYS_MS)),
            membershipName: latest.record.membershipName || ''
        });
    }

    return rows.sort((a, b) => b.cancellationsInWindow - a.cancellationsInWindow);
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

function buildLc7TagPayload(currentTags, memberId) {
    const tagIds = [];
    for (const tag of currentTags) {
        const tagId = Number(tag.id ?? tag.tagId ?? tag.tag?.id);
        if (!tagId || tagId === LC7_TAG_ID || tagId === P57_TAG_ID) continue;
        if (!tagIds.includes(tagId)) tagIds.push(tagId);
    }
    tagIds.push(LC7_TAG_ID);
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
    buildAtRiskRows,
    buildDetection,
    buildLc7TagPayload,
    buildP57TagPayload,
    detectMissedAssignments,
    findLatestTriggerAfter,
    findTriggerInEntries,
    findTriggeringMembers,
    getCompletedCycleRestartAfterByMemberId,
    getCancellationDate,
    getMemberId,
    getMostRecentLateCancellationDate,
    isLateCancellation,
    isUnlimitedMembership,
    makeCycleId,
    makeRawCancellationId,
    shouldTransitionToP57
};
