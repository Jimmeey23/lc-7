const crypto = require('crypto');
const { getConfig, LIFECYCLE_STATUSES, LC7_TAG_ID, P57_TAG_ID, MAX_AUTO_RETRIES } = require('./config');
const { formatIST, formatRunTimestamp, parseDate } = require('./date-utils');
const {
    buildAtRiskRows,
    buildLc7TagPayload,
    buildP57TagPayload,
    detectMissedAssignments,
    findLatestTriggerAfter,
    findTriggeringMembers,
    getCancellationDate,
    getMemberId,
    makeRawCancellationId
} = require('./lifecycle');
const { createEmailService } = require('./email-service');
const { createMomenceClient } = require('./momence-client');
const { createSheetsStore } = require('./sheets-store');

function filterTestMember(records, testMemberId) {
    if (!testMemberId) return records;
    return records.filter(record => Number(getMemberId(record)) === testMemberId);
}

function mapRawCancellationRows(records, skipped = []) {
    const now = formatRunTimestamp();
    const result = [];
    for (const record of records) {
        const memberId = getMemberId(record);
        if (!memberId || Number.isNaN(memberId)) {
            const msg = `SKIP raw row: no memberId, customerName=${record.customerName || 'unknown'}`;
            skipped.push(msg);
            console.warn(msg);
            continue;
        }
        result.push({
            rawId: makeRawCancellationId(record),
            memberId,
            memberName: record.customerName || record.memberName || '',
            memberEmail: record.customerEmail || record.email || '',
            cancelledEvent: record.cancelledEvent || record.sessionName || '',
            cancelledAt: formatIST(getCancellationDate(record) || record.cancelledDate),
            sessionAt: formatIST(record.sessionDate || record.startsAt),
            membershipName: record.membershipName || '',
            homeLocation: record.homeLocation || '',
            createdAt: now,
            comment: `Momence late cancellation imported. Member ${memberId} cancelled ${record.cancelledEvent || record.sessionName || 'a session'}.`
        });
    }
    return result;
}

async function assignLc7ForNewCycles(store, momence, cycles) {
    const assigned = [];
    let failedCount = 0;

    for (const cycle of cycles) {
        try {
            await momence.assignLc7Tag(cycle.memberId);
            const timestamp = formatRunTimestamp();
            const comment = `${cycle.actionComment || 'LC-7 lifecycle initiated.'} LC-7 tag assigned at ${timestamp}.`;
            await store.updateCycle(cycle.cycleId, {
                lc7TagAssignedAt: timestamp,
                status: LIFECYCLE_STATUSES.LC7_TAG_ASSIGNED,
                lastError: '',
                actionComment: comment
            });
            assigned.push({ ...cycle, lc7TagAssignedAt: timestamp, status: LIFECYCLE_STATUSES.LC7_TAG_ASSIGNED });
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
            const hasPartialFailures = result.failed.length > 0;
            const newStatus = hasPartialFailures ? LIFECYCLE_STATUSES.FAILED : LIFECYCLE_STATUSES.WAITING_7_DAYS;
            const failedNote = hasPartialFailures
                ? ` Failed to cancel: ${result.failed.map(item => `${item.bookingId}:${item.error}`).join(',')}.`
                : '';

            await store.updateCycle(cycle.cycleId, {
                futureBookingsCancelledCount: result.successful,
                status: newStatus,
                actionComment: `Future bookings: ${result.successful}/${result.total} cancelled.${failedNote} ${hasPartialFailures ? 'FAILED — some bookings not cancelled; will retry next run.' : 'Waiting 7+ days after latest late cancellation for P57 transition.'}`,
                lastError: hasPartialFailures
                    ? `Future booking cancellation failed: ${result.failed.map(item => `${item.bookingId}:${item.error}`).join(',')}`
                    : ''
            });

            if (hasPartialFailures) {
                failedCount++;
            } else {
                completedCycles.push({
                    ...cycle,
                    futureBookingsCancelledCount: result.successful,
                    status: LIFECYCLE_STATUSES.WAITING_7_DAYS
                });
            }
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

function getSentEmailIds(emailLogRows) {
    return new Set(
        emailLogRows
            .filter(row => row.status === 'SENT')
            .map(row => row.emailId)
            .filter(Boolean)
    );
}

function getPendingFailedEmailRows(emailLogRows) {
    const sentEmailIds = getSentEmailIds(emailLogRows);
    return emailLogRows.filter(row =>
        row.status === 'FAILED' &&
        !sentEmailIds.has(row.emailId)
    );
}

async function createCachedEmailStore(store, emailLogRows = null) {
    const rows = emailLogRows || await store.getEmailLogRows();
    const sentEmailIds = getSentEmailIds(rows);

    return {
        ...store,
        hasSentEmail: async emailId => Boolean(emailId && sentEmailIds.has(emailId)),
        appendEmailLog: async log => {
            await store.appendEmailLog(log);
            if (log.status === 'SENT' && log.emailId) {
                sentEmailIds.add(log.emailId);
            }
        }
    };
}

async function sendLifecycleEmails(store, emailService, cycles, template) {
    if (cycles.length === 0) return { sent: 0, failed: 0 };

    const emailStore = await createCachedEmailStore(store);
    let sent = 0;
    let failed = 0;

    for (const cycle of cycles) {
        try {
            const result = template === 'A'
                ? await emailService.sendTemplateA(emailStore, cycle)
                : await emailService.sendTemplateB(emailStore, cycle);
            if (result.sent || result.dryRun) sent++;
        } catch (error) {
            failed++;
            console.error(`Template ${template} email failed for member ${cycle.memberId}: ${error.message}`);
        }
    }

    return { sent, failed };
}

async function retryFailedLifecycleEmails(store, emailService, cycles) {
    const emailLogRows = await store.getEmailLogRows();
    const failedEmails = getPendingFailedEmailRows(emailLogRows);
    if (failedEmails.length === 0) return { sent: 0, failed: 0 };

    const emailStore = await createCachedEmailStore(store, emailLogRows);
    const cycleById = new Map(cycles.map(cycle => [cycle.cycleId, cycle]));
    let sent = 0;
    let failed = 0;

    for (const failedEmail of failedEmails) {
        const cycle = cycleById.get(failedEmail.cycleId);
        if (!cycle) continue;

        try {
            const result = await emailService.retryFailedEmail(emailStore, { ...cycle }, failedEmail);
            if (result.sent || result.dryRun) sent++;
        } catch (error) {
            failed++;
            console.error(`Retry ${failedEmail.template} email failed for member ${failedEmail.memberId}: ${error.message}`);
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
        const actionComment = `LC-7 waiting period reset: member reached another 3 late cancellations within 7 days. New trigger cancellation: ${latestLateCancellationAt}.`;
        const refreshedCycle = { ...cycle, latestLateCancellationAt, p57EligibleAt, actionComment };

        await store.updateCycle(cycle.cycleId, {
            latestLateCancellationAt,
            p57EligibleAt,
            actionComment,
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
    let lc7Restored = 0;
    const transitionedCycles = [];

    for (const cycle of cycles) {
        try {
            const p57EligibleAt = parseDate(cycle.p57EligibleAt);
            if (!p57EligibleAt) {
                failedCount++;
                await store.updateCycle(cycle.cycleId, {
                    lastError: `Invalid p57EligibleAt for WAITING_7_DAYS reconciliation: ${cycle.p57EligibleAt || ''}`,
                    actionComment: `WAITING_7_DAYS reconciliation skipped because p57EligibleAt is invalid or missing for member ${cycle.memberId}.`
                });
                continue;
            }

            const tags = await momence.fetchMemberTags(cycle.memberId);
            const tagIds = tags.map(tag => Number(tag.id ?? tag.tagId ?? tag.tag?.id)).filter(Boolean);
            const hasLc7 = tagIds.includes(LC7_TAG_ID);
            const hasP57 = tagIds.includes(P57_TAG_ID);
            const isEligibleForP57 = p57EligibleAt.getTime() <= now.getTime();

            if (isEligibleForP57) {
                const payload = buildP57TagPayload(tags, cycle.memberId);
                const timestamp = formatRunTimestamp();
                if (hasLc7 || !hasP57) {
                    await momence.assignTags(cycle.memberId, payload.tagIds);
                }
                const completedCycle = {
                    ...cycle,
                    p57TagAssignedAt: cycle.p57TagAssignedAt || timestamp,
                    status: LIFECYCLE_STATUSES.P57_TAG_ASSIGNED
                };
                await store.updateCycle(cycle.cycleId, {
                    p57TagAssignedAt: completedCycle.p57TagAssignedAt,
                    status: LIFECYCLE_STATUSES.P57_TAG_ASSIGNED,
                    lastError: '',
                    actionComment: hasLc7 || !hasP57
                        ? `LC-7 removed — p57EligibleAt ${cycle.p57EligibleAt} has been reached. P57 tag restored. Tag payload: [${payload.tagIds.join(',')}].`
                        : `LC-7 removed — P57 already present and LC-7 absent in Momence after p57EligibleAt ${cycle.p57EligibleAt} (reconciled at ${timestamp}).`
                });
                transitioned++;
                transitionedCycles.push(completedCycle);
                continue;
            }

            if (!hasLc7 || hasP57) {
                const payload = buildLc7TagPayload(tags, cycle.memberId);
                const timestamp = formatRunTimestamp();
                await momence.assignTags(cycle.memberId, payload.tagIds);
                await store.updateCycle(cycle.cycleId, {
                    lc7TagAssignedAt: cycle.lc7TagAssignedAt || timestamp,
                    p57TagAssignedAt: '',
                    status: LIFECYCLE_STATUSES.WAITING_7_DAYS,
                    lastError: '',
                    actionComment: `LC-7 restored — p57EligibleAt ${cycle.p57EligibleAt} has not been reached. P57 removed until eligibility date. Tag payload: [${payload.tagIds.join(',')}].`
                });
                lc7Restored++;
            }
        } catch (error) {
            failedCount++;
            await store.updateCycle(cycle.cycleId, {
                lastError: `WAITING_7_DAYS reconciliation failed: ${error.response?.status || error.message}`,
                actionComment: `WAITING_7_DAYS reconciliation attempted but failed for member ${cycle.memberId}.`
            });
        }
    }

    return { transitioned, failedCount, transitionedCycles, lc7Restored };
}

async function processOverrideCycles(store, momence, cycles) {
    let overridden = 0;
    let failedCount = 0;
    const overriddenCycles = [];

    for (const cycle of cycles) {
        try {
            const tags = await momence.fetchMemberTags(cycle.memberId);
            const tagIds = tags.map(tag => Number(tag.id ?? tag.tagId ?? tag.tag?.id)).filter(Boolean);
            const hasLc7 = tagIds.includes(LC7_TAG_ID);
            const hasP57 = tagIds.includes(P57_TAG_ID);
            const payload = buildP57TagPayload(tags, cycle.memberId);
            const timestamp = formatRunTimestamp();

            if (hasLc7 || !hasP57) {
                await momence.assignTags(cycle.memberId, payload.tagIds);
            }

            const completedCycle = {
                ...cycle,
                p57TagAssignedAt: timestamp,
                status: LIFECYCLE_STATUSES.P57_TAG_ASSIGNED,
                assignmentReason: cycle.assignmentReason || 'Manual OVERRIDE reset',
                lastError: '',
                actionComment: `Manual OVERRIDE consumed at ${timestamp}. LC-7 removed and P57 restored. Future late cancellations count after overridden trigger ${cycle.latestLateCancellationAt || 'unknown'}. Tag payload: [${payload.tagIds.join(',')}].`
            };

            await store.updateCycle(cycle.cycleId, {
                p57TagAssignedAt: completedCycle.p57TagAssignedAt,
                status: completedCycle.status,
                assignmentReason: completedCycle.assignmentReason,
                lastError: completedCycle.lastError,
                actionComment: completedCycle.actionComment
            });

            overridden++;
            overriddenCycles.push(completedCycle);
        } catch (error) {
            failedCount++;
            await store.updateCycle(cycle.cycleId, {
                lastError: `OVERRIDE processing failed: ${error.response?.status || error.message}`,
                actionComment: `Manual OVERRIDE processing attempted but failed for member ${cycle.memberId}.`
            });
        }
    }

    return { overridden, failedCount, overriddenCycles };
}

async function retryFailedCycles(store, momence) {
    const retryable = await store.getRetryableCycles();
    if (retryable.length === 0) return { retriedCount: 0, failedCount: 0, failedMemberIds: [] };

    let retriedCount = 0;
    let failedCount = 0;
    const failedMemberIds = [];

    async function recordRetryFailure(cycle, retryCount, originalError) {
        failedCount++;
        failedMemberIds.push(String(cycle.memberId));
        const newRetryCount = retryCount + 1;
        await store.incrementRetryCount(cycle.cycleId);
        if (newRetryCount >= MAX_AUTO_RETRIES) {
            await store.updateCycle(cycle.cycleId, {
                lastError: `Auto-retry exhausted (${MAX_AUTO_RETRIES} attempts). Manual intervention required. Original error: ${originalError}`
            });
        }
    }

    for (const cycle of retryable) {
        const retryCount = Number(cycle.retryCount || 0);
        const delayMs = Math.min(retryCount * 2000, 10000);
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));

        try {
            const lastError = cycle.lastError || '';
            // The step helpers catch their own errors and mark the cycle FAILED, so a
            // retry "fails" when they report failures — not only when they throw.
            let stepFailures = 0;
            if (lastError.includes('LC-7 tag assignment failed')) {
                const { assigned, failedCount: tagFailures } = await assignLc7ForNewCycles(store, momence, [cycle]);
                stepFailures += tagFailures;
                if (assigned.length > 0) {
                    stepFailures += (await cancelBookingsForAssignedCycles(store, momence, assigned)).failedCount;
                }
            } else if (lastError.includes('Future booking cancellation failed')) {
                // LC-7 was already assigned — only retry booking cancellation
                stepFailures += (await cancelBookingsForAssignedCycles(store, momence, [{ ...cycle, status: LIFECYCLE_STATUSES.LC7_TAG_ASSIGNED }])).failedCount;
            } else if (lastError.includes('P57 transition failed') || lastError.includes('WAITING_7_DAYS reconciliation failed')) {
                const now = new Date();
                stepFailures += (await transitionEligibleCycles(store, momence, [cycle], now)).failedCount;
            } else {
                // Unknown error — retry from tag assignment
                const { assigned, failedCount: tagFailures } = await assignLc7ForNewCycles(store, momence, [cycle]);
                stepFailures += tagFailures;
                if (assigned.length > 0) {
                    stepFailures += (await cancelBookingsForAssignedCycles(store, momence, assigned)).failedCount;
                }
            }

            retriedCount++;
            if (stepFailures > 0) {
                await recordRetryFailure(cycle, retryCount, cycle.lastError);
            }
        } catch (error) {
            await recordRetryFailure(cycle, retryCount, cycle.lastError || error.message);
        }
    }

    return { retriedCount, failedCount, failedMemberIds };
}

async function refreshCurrentLc7MembersSheet(store, momence, testMemberId = null, allCycles = null) {
    const lc7Members = filterTestMember(await momence.fetchLc7Members(), testMemberId);
    const lifecycleRows = allCycles || await store.getLifecycleRows();
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
            futureBookingsCancelledCount: lifecycle.futureBookingsCancelledCount || '',
            retryCount: lifecycle.retryCount || 0,
            status: lifecycle.status || 'LC7_TAG_PRESENT_OUTSIDE_LIFECYCLE',
            assignmentReason: lifecycle.assignmentReason ||
                'Member has LC-7 in Momence. No lifecycle row found — may be legacy or manual tag.',
            lastError: lifecycle.lastError || ''
        };
    });

    return store.refreshActiveLC7(rows);
}

async function run() {
    const now = new Date();
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
        retriedCount: 0,
        missedAssignmentsDetected: 0,
        skippedRecords: 0,
        failedCount: 0,
        emailsSent: 0,
        emailsFailed: 0,
        failedMemberIds: '',
        status: 'COMPLETED',
        message: ''
    };
    let store = null;

    try {
        console.log(`🚀 LC-7 lifecycle run started ${runId}${process.env.LOCATION_NAME ? ` [${process.env.LOCATION_NAME}]` : ''}`);
        console.log('⚙️ Loading configuration...');
        const config = getConfig();
        const momence = createMomenceClient(config);
        const emailService = createEmailService(config);

        if (config.dryRun) console.log('🧪 DRY_RUN=true: Momence mutations are skipped');
        if (config.testMemberId) console.log(`🧪 TEST_MEMBER_ID=${config.testMemberId}`);

        console.log('📊 Initializing lifecycle Google Sheet...');
        store = await createSheetsStore(config);

        // Step 1: Retry previously failed cycles before doing anything else
        console.log('🔁 Retrying failed lifecycle cycles...');
        const retryResult = await retryFailedCycles(store, momence);
        log.retriedCount = retryResult.retriedCount;
        log.failedCount += retryResult.failedCount;
        const failedMemberIdSet = new Set(retryResult.failedMemberIds);

        // Step 2: Fetch late-cancellation report
        console.log('📥 Fetching Momence late-cancellation report...');
        const reportRecords = filterTestMember(
            await momence.fetchLateCancellations(config.reportLookbackDays),
            config.testMemberId
        );
        log.rawRecordsFetched = reportRecords.length;

        // Step 3: Store raw records
        console.log(`📋 Storing ${reportRecords.length} raw late-cancellation records...`);
        const skipped = [];
        const rawRows = mapRawCancellationRows(reportRecords, skipped);
        log.rawRecordsInserted = await store.insertRawRows(rawRows);
        log.skippedRecords = skipped.length;

        // Step 4: Load current lifecycle state and consume manual overrides first
        const allCycles = await store.getLifecycleRows();
        const overrideCycles = filterTestMember(
            allCycles.filter(cycle => cycle.status === LIFECYCLE_STATUSES.OVERRIDE),
            config.testMemberId
        );
        if (overrideCycles.length > 0) {
            console.log(`🧯 Processing ${overrideCycles.length} manual OVERRIDE cycle(s)...`);
        }
        const overrideResult = await processOverrideCycles(store, momence, overrideCycles);
        log.p57Assigned += overrideResult.overridden;
        log.failedCount += overrideResult.failedCount;
        for (const cycle of overrideResult.overriddenCycles) {
            await store.appendCompletedCycle(cycle);
        }
        const lifecycleRowsForDetection = overrideCycles.length > 0
            ? await store.getLifecycleRows()
            : allCycles;

        // Step 5: Normal detection — new triggers from today's data
        console.log('🧠 Evaluating lifecycle detections...');
        const detections = findTriggeringMembers(reportRecords, lifecycleRowsForDetection, now, console.warn);
        log.cyclesCreated += await store.insertLifecycleRows(detections);

        // Step 6: Missed assignment detection — historical triggers with no cycle record
        console.log('🔍 Detecting missed historical LC-7 assignments...');
        const missedDetections = detectMissedAssignments(reportRecords, lifecycleRowsForDetection, now);
        log.missedAssignmentsDetected = missedDetections.length;
        if (missedDetections.length > 0) {
            console.log(`⚠️  Found ${missedDetections.length} missed assignment(s)`);
        }

        const expiredMissed = missedDetections.filter(d => d.isExpired);
        const activeMissed = missedDetections.filter(d => !d.isExpired);

        // Step 6a: Expired missed cycles — close immediately, no tag assignment
        if (expiredMissed.length > 0) {
            console.log(`📁 Closing ${expiredMissed.length} expired missed assignments (penalty period already passed)...`);
            await store.insertLifecycleRows(expiredMissed);
            for (const cycle of expiredMissed) {
                await store.appendCompletedCycle(cycle);
            }
            log.cyclesCreated += expiredMissed.length;
        }

        // Step 6b: Active missed cycles — assign LC-7 silently (no Template A email)
        if (activeMissed.length > 0) {
            console.log(`🏷️ Silently assigning LC-7 for ${activeMissed.length} backdated missed cycle(s)...`);
            await store.insertLifecycleRows(activeMissed);
            const { assigned: backdatedAssigned, failedCount: backdatedTagFailures } = await assignLc7ForNewCycles(store, momence, activeMissed);
            log.lc7Assigned += backdatedAssigned.length;
            log.failedCount += backdatedTagFailures;
            log.cyclesCreated += activeMissed.length;

            if (backdatedAssigned.length > 0) {
                const { totalCancelled: backdatedCancelled, failedCount: backdatedCancelFailures } = await cancelBookingsForAssignedCycles(store, momence, backdatedAssigned);
                log.bookingsCancelled += backdatedCancelled;
                log.failedCount += backdatedCancelFailures;
            }
        }

        // Step 7: Assign LC-7 for new normal cycles
        console.log(`🏷️ Assigning LC-7 for ${detections.length} new lifecycle cycle(s)...`);
        const { assigned, failedCount: lc7Failures } = await assignLc7ForNewCycles(store, momence, detections);
        log.lc7Assigned += assigned.length;
        log.failedCount += lc7Failures;

        // Step 8: Cancel future bookings for newly assigned cycles
        console.log(`🚫 Cancelling future bookings for ${assigned.length} newly assigned LC-7 member(s)...`);
        const { totalCancelled, failedCount: cancelFailures } = await cancelBookingsForAssignedCycles(store, momence, assigned);
        log.bookingsCancelled += totalCancelled;
        log.failedCount += cancelFailures;

        // Step 9: Load WAITING_7_DAYS cycles
        const waitingCycles = filterTestMember(
            await store.getCyclesByStatus(LIFECYCLE_STATUSES.WAITING_7_DAYS),
            config.testMemberId
        );

        // Step 10: Send Template A emails to non-backdated waiting cycles
        console.log('📧 Sending LC-7 pause emails for eligible active cycles...');
        const templateAResult = await sendLifecycleEmails(store, emailService, waitingCycles, 'A');
        log.emailsSent += templateAResult.sent;
        log.emailsFailed += templateAResult.failed;

        // Step 11: Refresh trigger dates for waiting cycles
        const { refreshedCycles, refreshedCount } = await refreshWaitingCycleTriggerDates(store, reportRecords, waitingCycles);
        if (refreshedCount > 0) console.log(`🔁 Reset LC-7 waiting period for ${refreshedCount} active lifecycle cycle(s)`);

        // Step 12: Reconcile all WAITING_7_DAYS tag states against p57EligibleAt
        console.log('🔄 Reconciling WAITING_7_DAYS cycles against Momence tags and P57 eligibility...');
        const {
            transitioned,
            failedCount: transitionFailures,
            transitionedCycles,
            lc7Restored
        } = await transitionEligibleCycles(store, momence, refreshedCycles, now);
        log.p57Assigned += transitioned;
        log.lc7Assigned += lc7Restored;
        log.failedCount += transitionFailures;

        // Step 13: Append newly completed cycles to CompletedLC7 tab
        for (const cycle of transitionedCycles) {
            await store.appendCompletedCycle(cycle);
        }

        // Step 14: Send Template B emails for P57 cycles
        console.log('📧 Sending booking-restored emails for eligible P57 cycles...');
        const p57Cycles = filterTestMember(
            await store.getCyclesByStatus(LIFECYCLE_STATUSES.P57_TAG_ASSIGNED),
            config.testMemberId
        );
        const templateBResult = await sendLifecycleEmails(store, emailService, p57Cycles, 'B');
        log.emailsSent += templateBResult.sent;
        log.emailsFailed += templateBResult.failed;

        // Step 15: Retry failed emails
        console.log('📧 Retrying failed lifecycle emails...');
        const allCurrentCycles = await store.getLifecycleRows();
        const retryEmailResult = await retryFailedLifecycleEmails(store, emailService, allCurrentCycles);
        log.emailsSent += retryEmailResult.sent;
        log.emailsFailed += retryEmailResult.failed;

        // Step 16: Build AtRisk sheet — members with 1–2 cancellations in window
        console.log('⚠️  Refreshing AtRisk members sheet...');
        const activeMemberIds = new Set(
            allCurrentCycles
                .filter(c => c.status === LIFECYCLE_STATUSES.WAITING_7_DAYS || c.status === LIFECYCLE_STATUSES.LC7_TAG_ASSIGNED)
                .map(c => Number(c.memberId))
                .filter(Boolean)
        );
        const atRiskRows = buildAtRiskRows(reportRecords, activeMemberIds, now, allCurrentCycles);
        await store.refreshAtRiskSheet(atRiskRows);

        // Step 17: Refresh ActiveLC7 dashboard sheet
        console.log('📌 Refreshing ActiveLC7 sheet...');
        await refreshCurrentLc7MembersSheet(store, momence, config.testMemberId, allCurrentCycles);

        // Collect all currently-failed member IDs for the run log
        const failedCycles = allCurrentCycles.filter(c => c.status === LIFECYCLE_STATUSES.FAILED);
        for (const c of failedCycles) failedMemberIdSet.add(String(c.memberId));
        log.failedMemberIds = [...failedMemberIdSet].filter(Boolean).join(', ');

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
    processOverrideCycles,
    refreshCurrentLc7MembersSheet,
    refreshWaitingCycleTriggerDates,
    retryFailedCycles,
    retryFailedLifecycleEmails,
    run,
    sendLifecycleEmails,
    transitionEligibleCycles
};
