const crypto = require('crypto');
const { getConfig, LIFECYCLE_STATUSES } = require('./config');
const { formatIST, formatRunTimestamp } = require('./date-utils');
const {
    buildP57TagPayload,
    findLatestTriggerAfter,
    findTriggeringMembers,
    getCancellationDate,
    getMemberId,
    makeRawCancellationId,
    shouldTransitionToP57
} = require('./lifecycle');
const { createEmailService } = require('./email-service');
const { createMomenceClient } = require('./momence-client');
const { createSheetsStore } = require('./sheets-store');

function filterTestMember(records, testMemberId) {
    if (!testMemberId) return records;
    return records.filter(record => Number(getMemberId(record)) === testMemberId);
}

function mapRawCancellationRows(records) {
    const now = formatRunTimestamp();
    return records.map(record => ({
        rawId: makeRawCancellationId(record),
        memberId: getMemberId(record),
        memberName: record.customerName || record.memberName || '',
        memberEmail: record.customerEmail || record.email || '',
        cancelledEvent: record.cancelledEvent || record.sessionName || '',
        cancelledAt: formatIST(getCancellationDate(record) || record.cancelledDate),
        sessionAt: formatIST(record.sessionDate || record.startsAt),
        membershipName: record.membershipName || '',
        homeLocation: record.homeLocation || '',
        createdAt: now,
        comment: `Raw Momence late cancellation imported for lifecycle evaluation. Member ${getMemberId(record)} cancelled ${record.cancelledEvent || record.sessionName || 'a session'}.`
    }));
}

async function assignLc7ForNewCycles(store, momence, cycles) {
    const assigned = [];
    let failedCount = 0;

    for (const cycle of cycles) {
        try {
            await momence.assignLc7Tag(cycle.memberId);
            const timestamp = formatRunTimestamp();
            await store.updateCycle(cycle.cycleId, {
                lc7TagAssignedAt: timestamp,
                status: LIFECYCLE_STATUSES.LC7_TAG_ASSIGNED,
                lastError: '',
                actionComment: `${cycle.actionComment || 'LC-7 lifecycle initiated.'} LC-7 tag assigned at ${timestamp}.`
            });
            assigned.push({ ...cycle, lc7TagAssignedAt: timestamp });
        } catch (error) {
            failedCount++;
            await store.updateCycle(cycle.cycleId, {
                status: LIFECYCLE_STATUSES.FAILED,
                lastError: `LC-7 tag assignment failed: ${error.response?.status || error.message}`,
                actionComment: `LC-7 tag assignment failed for member ${cycle.memberId}.`
            });
        }
    }

    return { assigned, failedCount };
}

async function cancelBookingsForAssignedCycles(store, momence, assignedCycles) {
    let totalCancelled = 0;
    let failedCount = 0;
    const completedCycles = [];

    for (const cycle of assignedCycles) {
        try {
            const result = await momence.cancelFutureBookings(cycle.memberId);
            totalCancelled += result.successful;
            const futureBookingsCancelledAt = formatRunTimestamp();

            await store.updateCycle(cycle.cycleId, {
                futureBookingsCancelledAt,
                futureBookingsCancelledCount: result.successful,
                status: LIFECYCLE_STATUSES.WAITING_7_DAYS,
                actionComment: `Future booking cancellation ran immediately after LC-7 assignment. ${result.successful}/${result.total} future bookings cancelled. Waiting until more than 7 days after latest late cancellation before P57 transition.`,
                lastError: result.failed.length > 0
                    ? `Failed booking cancellations: ${result.failed.map(item => `${item.bookingId}:${item.error}`).join(',')}`
                    : ''
            });
            completedCycles.push({
                ...cycle,
                futureBookingsCancelledAt,
                futureBookingsCancelledCount: result.successful,
                status: LIFECYCLE_STATUSES.WAITING_7_DAYS
            });
        } catch (error) {
            failedCount++;
            await store.updateCycle(cycle.cycleId, {
                status: LIFECYCLE_STATUSES.FAILED,
                lastError: `Future booking cancellation failed: ${error.response?.status || error.message}`,
                actionComment: `Future booking cancellation failed after LC-7 assignment for member ${cycle.memberId}.`
            });
        }
    }

    return { completedCycles, totalCancelled, failedCount };
}

async function sendLifecycleEmails(store, emailService, cycles, template) {
    let sent = 0;
    let failed = 0;

    for (const cycle of cycles) {
        try {
            const result = template === 'A'
                ? await emailService.sendTemplateA(store, cycle)
                : await emailService.sendTemplateB(store, cycle);
            if (result.sent || result.dryRun) sent++;
        } catch (error) {
            failed++;
            console.error(`Template ${template} email failed for member ${cycle.memberId}: ${error.message}`);
        }
    }

    return { sent, failed };
}

async function refreshWaitingCycleTriggerDates(store, rawCancellations, cycles) {
    const refreshedCycles = [];
    let refreshedCount = 0;

    for (const cycle of cycles) {
        const latestTrigger = findLatestTriggerAfter(
            rawCancellations,
            cycle.memberId,
            cycle.latestLateCancellationAt
        );

        if (!latestTrigger) {
            refreshedCycles.push(cycle);
            continue;
        }

        const latestLateCancellationAt = formatIST(latestTrigger.trigger.cancelledAt);
        const p57EligibleAt = formatIST(new Date(latestTrigger.trigger.cancelledAt.getTime() + 7 * 24 * 60 * 60 * 1000));
        const refreshedCycle = {
            ...cycle,
            latestLateCancellationAt,
            p57EligibleAt,
            actionComment: `${cycle.actionComment || ''} LC-7 waiting period reset because member reached another 3 late cancellations within 7 days. New trigger cancellation: ${latestLateCancellationAt}.`
        };

        await store.updateCycle(cycle.cycleId, {
            latestLateCancellationAt,
            p57EligibleAt,
            actionComment: refreshedCycle.actionComment,
            lastError: ''
        });
        refreshedCount++;
        refreshedCycles.push(refreshedCycle);
    }

    return { refreshedCycles, refreshedCount };
}

async function transitionEligibleCycles(store, momence, cycles, now = new Date()) {
    let transitioned = 0;
    let failedCount = 0;

    for (const cycle of cycles) {
        try {
            const tags = await momence.fetchMemberTags(cycle.memberId);
            const decision = shouldTransitionToP57(cycle, tags, now);
            if (!decision.shouldTransition) continue;

            const payload = buildP57TagPayload(tags, cycle.memberId);
            await momence.assignTags(cycle.memberId, payload.tagIds);
            await store.updateCycle(cycle.cycleId, {
                p57TagAssignedAt: formatRunTimestamp(),
                status: LIFECYCLE_STATUSES.P57_TAG_ASSIGNED,
                lastError: '',
                actionComment: `P57 tag assigned and LC-7 removed because latest late cancellation ${cycle.latestLateCancellationAt} is more than 7 days old. Payload tagIds: ${payload.tagIds.join(',')}.`
            });
            transitioned++;
        } catch (error) {
            failedCount++;
            await store.updateCycle(cycle.cycleId, {
                lastError: `P57 transition failed: ${error.response?.status || error.message}`,
                actionComment: `P57 transition attempted but failed for member ${cycle.memberId}.`
            });
        }
    }

    return { transitioned, failedCount };
}

async function refreshCurrentLc7MembersSheet(store, momence, testMemberId = null) {
    const lc7Members = filterTestMember(await momence.fetchLc7Members(), testMemberId);
    const lifecycleRows = await store.getLifecycleRows();
    const lifecycleByMemberId = new Map(
        lifecycleRows
            .filter(row => row.status !== LIFECYCLE_STATUSES.P57_TAG_ASSIGNED)
            .map(row => [Number(row.memberId), row])
    );

    const rows = lc7Members.map(member => {
        const lifecycle = lifecycleByMemberId.get(Number(member.memberId)) || {};
        return {
            memberId: member.memberId,
            memberName: [member.firstName, member.lastName].filter(Boolean).join(' ') || lifecycle.memberName || '',
            memberEmail: member.email || lifecycle.memberEmail || '',
            latestLateCancellationAt: lifecycle.latestLateCancellationAt || '',
            lc7TagAssignedAt: lifecycle.lc7TagAssignedAt || '',
            p57EligibleAt: lifecycle.p57EligibleAt || '',
            status: lifecycle.status || 'LC7_TAG_PRESENT_OUTSIDE_LIFECYCLE',
            comment: lifecycle.actionComment ||
                'Member currently has LC-7 in Momence. No lifecycle row was found, so this may be from legacy automation or manual tagging.'
        };
    });

    return store.refreshCurrentLc7Members(rows);
}

async function run() {
    const startedAt = formatRunTimestamp();
    const runId = crypto.randomUUID();
    const log = {
        runId,
        startedAt,
        rawRecordsFetched: 0,
        rawRecordsInserted: 0,
        cyclesCreated: 0,
        lc7Assigned: 0,
        bookingsCancelled: 0,
        p57Assigned: 0,
        failedCount: 0,
        emailsSent: 0,
        emailsFailed: 0,
        status: 'COMPLETED',
        message: ''
    };
    let store = null;

    try {
        console.log(`🚀 LC-7 lifecycle run started ${runId}`);
        console.log('⚙️ Loading configuration...');
        const config = getConfig();
        const momence = createMomenceClient(config);
        const emailService = createEmailService(config);

        if (config.dryRun) console.log('🧪 DRY_RUN=true: Momence mutations are skipped');
        if (config.testMemberId) console.log(`🧪 TEST_MEMBER_ID=${config.testMemberId}`);

        console.log('📊 Initializing lifecycle Google Sheet...');
        store = await createSheetsStore(config);

        console.log('📥 Fetching Momence late-cancellation report...');
        const reportRecords = filterTestMember(await momence.fetchLateCancellations(), config.testMemberId);
        log.rawRecordsFetched = reportRecords.length;

        console.log(`📋 Storing ${reportRecords.length} raw late-cancellation records...`);
        const rawRows = mapRawCancellationRows(reportRecords);
        log.rawRecordsInserted = await store.insertRawRows(rawRows);

        console.log('🧠 Evaluating lifecycle detections...');
        const allCycles = await store.getLifecycleRows();
        const detections = findTriggeringMembers(reportRecords, allCycles);
        log.cyclesCreated = await store.insertLifecycleRows(detections);

        console.log(`🏷️ Assigning LC-7 for ${detections.length} new lifecycle cycles...`);
        const { assigned, failedCount: lc7Failures } = await assignLc7ForNewCycles(store, momence, detections);
        log.lc7Assigned = assigned.length;
        log.failedCount += lc7Failures;

        console.log(`🚫 Cancelling future bookings for ${assigned.length} newly assigned LC-7 members...`);
        const {
            totalCancelled,
            failedCount: cancelFailures
        } = await cancelBookingsForAssignedCycles(store, momence, assigned);
        log.bookingsCancelled = totalCancelled;
        log.failedCount += cancelFailures;

        console.log('🔄 Checking WAITING_7_DAYS cycles for P57 transition...');
        const waitingCycles = filterTestMember(
            await store.getCyclesByStatus(LIFECYCLE_STATUSES.WAITING_7_DAYS),
            config.testMemberId
        );
        console.log('📧 Sending LC-7 pause emails for eligible active cycles...');
        const templateAResult = await sendLifecycleEmails(store, emailService, waitingCycles, 'A');
        log.emailsSent += templateAResult.sent;
        log.emailsFailed += templateAResult.failed;
        log.failedCount += templateAResult.failed;

        const { refreshedCycles, refreshedCount } = await refreshWaitingCycleTriggerDates(store, reportRecords, waitingCycles);
        if (refreshedCount > 0) console.log(`🔁 Reset LC-7 waiting period for ${refreshedCount} active lifecycle cycles`);
        const { transitioned, failedCount: transitionFailures } = await transitionEligibleCycles(store, momence, refreshedCycles);
        log.p57Assigned = transitioned;
        log.failedCount += transitionFailures;

        console.log('📧 Sending booking-restored emails for eligible P57 cycles...');
        const p57Cycles = filterTestMember(
            await store.getCyclesByStatus(LIFECYCLE_STATUSES.P57_TAG_ASSIGNED),
            config.testMemberId
        );
        const templateBResult = await sendLifecycleEmails(store, emailService, p57Cycles, 'B');
        log.emailsSent += templateBResult.sent;
        log.emailsFailed += templateBResult.failed;
        log.failedCount += templateBResult.failed;

        console.log('📌 Refreshing CurrentLC7Members sheet...');
        await refreshCurrentLc7MembersSheet(store, momence, config.testMemberId);

        console.log(`✅ Run complete: ${JSON.stringify(log)}`);
    } catch (error) {
        log.status = 'FAILED';
        log.failedCount += 1;
        log.message = error.stack || error.message;
        console.error(`💥 Run failed: ${error.stack || error.message}`);
        throw error;
    } finally {
        log.finishedAt = formatRunTimestamp();
        if (store) {
            await store.appendRunLog(log);
        }
    }
}

if (require.main === module) {
    run().catch(error => {
        console.error(error.stack || error.message);
        process.exit(1);
    });
}

module.exports = {
    assignLc7ForNewCycles,
    cancelBookingsForAssignedCycles,
    filterTestMember,
    mapRawCancellationRows,
    sendLifecycleEmails,
    refreshWaitingCycleTriggerDates,
    refreshCurrentLc7MembersSheet,
    run,
    transitionEligibleCycles
};
