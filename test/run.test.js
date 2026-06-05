const test = require('node:test');
const assert = require('node:assert/strict');
const { LIFECYCLE_STATUSES } = require('../src/config');
const { refreshWaitingCycleTriggerDates } = require('../src/run');

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
