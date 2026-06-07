const test = require('node:test');
const assert = require('node:assert/strict');
const { LIFECYCLE_STATUSES } = require('../src/config');
const { createEmailService } = require('../src/email-service');
const {
    processOverrideCycles,
    refreshWaitingCycleTriggerDates,
    retryFailedLifecycleEmails,
    sendLifecycleEmails,
    transitionEligibleCycles
} = require('../src/run');

function cancellation(memberId, cancelledDate) {
    return {
        memberId,
        customerName: 'Member',
        customerEmail: 'member@example.com',
        cancelledDate,
        sessionDate: cancelledDate,
        membershipName: 'Studio Annual Unlimited Membership'
    };
}

function emailCycle(overrides = {}) {
    return {
        cycleId: 'cycle-1',
        memberId: 100,
        memberName: 'Member One',
        memberEmail: 'member@example.com',
        latestLateCancellationAt: '27-05-2026 10:00:00',
        p57EligibleAt: '03-06-2026 10:00:00',
        status: LIFECYCLE_STATUSES.P57_TAG_ASSIGNED,
        ...overrides
    };
}

function makeEmailService(requests) {
    return createEmailService({
        dryRun: false,
        mail: {
            apiUrl: 'https://sandbox.api.mailtrap.io/api/send/123',
            apiToken: 'token',
            from: 'hello@physique57india.com',
            fromName: 'Mailtrap Test',
            replyTo: 'latecancellations@physique57india.com'
        }
    }, {
        post: async (url, payload) => {
            requests.push({ url, payload });
            return { data: { success: true } };
        }
    });
}

test('refreshWaitingCycleTriggerDates writes a bounded reset comment instead of appending old sheet history', async () => {
    const updates = [];
    const store = {
        updateCycle: async (cycleId, changes) => updates.push({ cycleId, changes })
    };
    const cycle = {
        cycleId: 'cycle-1',
        memberId: 100,
        latestLateCancellationAt: '22-05-2026 05:30:00',
        p57EligibleAt: '29-05-2026 05:30:00',
        status: LIFECYCLE_STATUSES.WAITING_7_DAYS,
        actionComment: 'Historical lifecycle note. '.repeat(2500)
    };

    const result = await refreshWaitingCycleTriggerDates(store, [
        cancellation(100, '2026-05-24T00:00:00.000Z'),
        cancellation(100, '2026-05-25T00:00:00.000Z'),
        cancellation(100, '2026-05-26T00:00:00.000Z')
    ], [cycle]);

    assert.equal(result.refreshedCount, 1);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].cycleId, 'cycle-1');
    assert.ok(updates[0].changes.actionComment.length < 50000);
    assert.doesNotMatch(updates[0].changes.actionComment, /Historical lifecycle note/);
    assert.match(updates[0].changes.actionComment, /New trigger cancellation: 26-05-2026 05:30:00\./);
    assert.equal(result.refreshedCycles[0].actionComment, updates[0].changes.actionComment);
});

test('processOverrideCycles removes LC-7, adds P57, and consumes OVERRIDE status', async () => {
    const updates = [];
    const assignTagsCalls = [];
    const store = {
        updateCycle: async (cycleId, changes) => updates.push({ cycleId, changes })
    };
    const momence = {
        fetchMemberTags: async () => [{ id: 999 }, { id: 164561 }],
        assignTags: async (memberId, tagIds) => assignTagsCalls.push({ memberId, tagIds })
    };

    const result = await processOverrideCycles(store, momence, [{
        cycleId: 'cycle-override',
        memberId: 100,
        latestLateCancellationAt: '03-06-2026 10:00:00',
        status: LIFECYCLE_STATUSES.OVERRIDE
    }]);

    assert.equal(result.overridden, 1);
    assert.equal(result.failedCount, 0);
    assert.deepEqual(assignTagsCalls, [{ memberId: 100, tagIds: [999, 164581] }]);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].cycleId, 'cycle-override');
    assert.equal(updates[0].changes.status, LIFECYCLE_STATUSES.P57_TAG_ASSIGNED);
    assert.equal(updates[0].changes.lastError, '');
    assert.match(updates[0].changes.p57TagAssignedAt, /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/);
    assert.match(updates[0].changes.actionComment, /Manual OVERRIDE consumed/);
});

test('sendLifecycleEmails reads EmailLog once for batch dedupe', async () => {
    const requests = [];
    const logs = [];
    let emailLogReads = 0;
    const store = {
        getEmailLogRows: async () => {
            emailLogReads++;
            return [];
        },
        hasSentEmail: async () => {
            throw new Error('uncached hasSentEmail should not be used during batch send');
        },
        appendEmailLog: async log => logs.push(log)
    };

    const result = await sendLifecycleEmails(store, makeEmailService(requests), [
        emailCycle({ cycleId: 'cycle-1', memberId: 100, memberEmail: 'one@example.com' }),
        emailCycle({ cycleId: 'cycle-2', memberId: 200, memberEmail: 'two@example.com' })
    ], 'B');

    assert.equal(result.sent, 2);
    assert.equal(result.failed, 0);
    assert.equal(emailLogReads, 1);
    assert.equal(requests.length, 2);
    assert.equal(logs.length, 2);
});

test('retryFailedLifecycleEmails reuses one EmailLog read for failed rows and dedupe', async () => {
    const requests = [];
    const logs = [];
    let emailLogReads = 0;
    const store = {
        getEmailLogRows: async () => {
            emailLogReads++;
            return [{
                emailId: 'failed-email-id',
                cycleId: 'cycle-1',
                memberId: 100,
                memberEmail: 'fallback@example.com',
                template: 'A',
                status: 'FAILED'
            }];
        },
        getFailedEmailRows: async () => {
            throw new Error('uncached getFailedEmailRows should not be used during retry');
        },
        hasSentEmail: async () => {
            throw new Error('uncached hasSentEmail should not be used during retry');
        },
        appendEmailLog: async log => logs.push(log)
    };

    const result = await retryFailedLifecycleEmails(store, makeEmailService(requests), [
        emailCycle({
            cycleId: 'cycle-1',
            memberId: 100,
            memberEmail: '',
            status: LIFECYCLE_STATUSES.WAITING_7_DAYS
        })
    ]);

    assert.equal(result.sent, 1);
    assert.equal(result.failed, 0);
    assert.equal(emailLogReads, 1);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].payload.to, [{ email: 'fallback@example.com' }]);
    assert.equal(logs.length, 1);
});

test('transitionEligibleCycles assigns P57 when eligible waiting cycle has no lifecycle tags', async () => {
    const updates = [];
    const assignTagsCalls = [];
    const store = {
        updateCycle: async (cycleId, changes) => updates.push({ cycleId, changes })
    };
    const momence = {
        fetchMemberTags: async () => [],
        assignTags: async (memberId, tagIds) => assignTagsCalls.push({ memberId, tagIds })
    };

    const result = await transitionEligibleCycles(store, momence, [{
        cycleId: 'cycle-1',
        memberId: 100,
        latestLateCancellationAt: '22-05-2026 05:30:00',
        p57EligibleAt: '29-05-2026 05:30:00',
        status: LIFECYCLE_STATUSES.WAITING_7_DAYS
    }], new Date('2026-06-02T00:00:00.000Z'));

    assert.equal(result.transitioned, 1);
    assert.equal(result.lc7Restored, 0);
    assert.deepEqual(assignTagsCalls, [{ memberId: 100, tagIds: [164581] }]);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].cycleId, 'cycle-1');
    assert.equal(updates[0].changes.status, LIFECYCLE_STATUSES.P57_TAG_ASSIGNED);
    assert.match(updates[0].changes.actionComment, /P57 tag restored/);
});

test('transitionEligibleCycles removes LC-7 and preserves other tags when P57 eligibility is reached', async () => {
    const updates = [];
    const assignTagsCalls = [];
    const store = {
        updateCycle: async (cycleId, changes) => updates.push({ cycleId, changes })
    };
    const momence = {
        fetchMemberTags: async () => [{ id: 999 }, { id: 164561 }],
        assignTags: async (memberId, tagIds) => assignTagsCalls.push({ memberId, tagIds })
    };

    const result = await transitionEligibleCycles(store, momence, [{
        cycleId: 'cycle-1',
        memberId: 100,
        latestLateCancellationAt: '22-05-2026 05:30:00',
        p57EligibleAt: '29-05-2026 05:30:00',
        status: LIFECYCLE_STATUSES.WAITING_7_DAYS
    }], new Date('2026-06-02T00:00:00.000Z'));

    assert.equal(result.transitioned, 1);
    assert.deepEqual(assignTagsCalls, [{ memberId: 100, tagIds: [999, 164581] }]);
    assert.equal(updates[0].changes.status, LIFECYCLE_STATUSES.P57_TAG_ASSIGNED);
});

test('transitionEligibleCycles restores LC-7 and removes P57 when waiting cycle is not yet eligible', async () => {
    const updates = [];
    const assignTagsCalls = [];
    const store = {
        updateCycle: async (cycleId, changes) => updates.push({ cycleId, changes })
    };
    const momence = {
        fetchMemberTags: async () => [{ id: 999 }, { id: 164581 }],
        assignTags: async (memberId, tagIds) => assignTagsCalls.push({ memberId, tagIds })
    };

    const result = await transitionEligibleCycles(store, momence, [{
        cycleId: 'cycle-1',
        memberId: 100,
        latestLateCancellationAt: '02-06-2026 19:05:21',
        p57EligibleAt: '09-06-2026 19:05:21',
        status: LIFECYCLE_STATUSES.WAITING_7_DAYS
    }], new Date('2026-06-07T09:05:21.000Z'));

    assert.equal(result.transitioned, 0);
    assert.equal(result.lc7Restored, 1);
    assert.deepEqual(assignTagsCalls, [{ memberId: 100, tagIds: [999, 164561] }]);
    assert.equal(updates[0].changes.status, LIFECYCLE_STATUSES.WAITING_7_DAYS);
    assert.equal(updates[0].changes.p57TagAssignedAt, '');
    assert.match(updates[0].changes.actionComment, /LC-7 restored/);
});

test('transitionEligibleCycles leaves correct non-eligible LC-7 tag state unchanged', async () => {
    const updates = [];
    const assignTagsCalls = [];
    const store = {
        updateCycle: async (cycleId, changes) => updates.push({ cycleId, changes })
    };
    const momence = {
        fetchMemberTags: async () => [{ id: 164561 }],
        assignTags: async (memberId, tagIds) => assignTagsCalls.push({ memberId, tagIds })
    };

    const result = await transitionEligibleCycles(store, momence, [{
        cycleId: 'cycle-1',
        memberId: 100,
        latestLateCancellationAt: '02-06-2026 19:05:21',
        p57EligibleAt: '09-06-2026 19:05:21',
        status: LIFECYCLE_STATUSES.WAITING_7_DAYS
    }], new Date('2026-06-07T09:05:21.000Z'));

    assert.equal(result.transitioned, 0);
    assert.equal(result.lc7Restored, 0);
    assert.deepEqual(assignTagsCalls, []);
    assert.deepEqual(updates, []);
});

test('transitionEligibleCycles records invalid p57EligibleAt without mutating tags', async () => {
    const updates = [];
    const assignTagsCalls = [];
    const store = {
        updateCycle: async (cycleId, changes) => updates.push({ cycleId, changes })
    };
    const momence = {
        fetchMemberTags: async () => [{ id: 164561 }],
        assignTags: async (memberId, tagIds) => assignTagsCalls.push({ memberId, tagIds })
    };

    const result = await transitionEligibleCycles(store, momence, [{
        cycleId: 'cycle-1',
        memberId: 100,
        latestLateCancellationAt: '02-06-2026 19:05:21',
        p57EligibleAt: '',
        status: LIFECYCLE_STATUSES.WAITING_7_DAYS
    }], new Date('2026-06-07T09:05:21.000Z'));

    assert.equal(result.transitioned, 0);
    assert.equal(result.lc7Restored, 0);
    assert.equal(result.failedCount, 1);
    assert.deepEqual(assignTagsCalls, []);
    assert.match(updates[0].changes.lastError, /Invalid p57EligibleAt/);
});
