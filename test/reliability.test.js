const test = require('node:test');
const assert = require('node:assert/strict');
const { LIFECYCLE_STATUSES, MAX_AUTO_RETRIES } = require('../src/config');
const { retryFailedCycles } = require('../src/run');
const { startOfTodayIST } = require('../src/momence-client');

function makeStore(cycle) {
    const updates = [];
    const increments = [];
    return {
        updates,
        increments,
        getRetryableCycles: async () => [cycle],
        updateCycle: async (cycleId, changes) => updates.push({ cycleId, changes }),
        incrementRetryCount: async cycleId => increments.push(cycleId)
    };
}

test('retryFailedCycles increments retryCount when the retried step fails internally', async () => {
    const cycle = { cycleId: 'c1', memberId: 1, retryCount: 0, status: LIFECYCLE_STATUSES.FAILED, lastError: 'LC-7 tag assignment failed: 500' };
    const store = makeStore(cycle);
    const momence = { assignLc7Tag: async () => { throw new Error('boom'); } };

    const result = await retryFailedCycles(store, momence);

    assert.deepEqual(store.increments, ['c1']);
    assert.equal(result.failedCount, 1);
    assert.equal(result.retriedCount, 1);
    assert.deepEqual(result.failedMemberIds, ['1']);
});

test('retryFailedCycles does not increment retryCount on success', async () => {
    const cycle = { cycleId: 'c2', memberId: 2, retryCount: 0, status: LIFECYCLE_STATUSES.FAILED, lastError: 'LC-7 tag assignment failed: 500' };
    const store = makeStore(cycle);
    const momence = {
        assignLc7Tag: async () => ({ success: true }),
        cancelFutureBookings: async () => ({ total: 0, successful: 0, failed: [], bookingIds: [] })
    };

    const result = await retryFailedCycles(store, momence);

    assert.deepEqual(store.increments, []);
    assert.equal(result.failedCount, 0);
    assert.equal(store.updates.at(-1).changes.status, LIFECYCLE_STATUSES.WAITING_7_DAYS);
});

test('retryFailedCycles counts a failed booking-cancellation retry', async () => {
    const cycle = { cycleId: 'c3', memberId: 3, retryCount: 0, status: LIFECYCLE_STATUSES.FAILED, lastError: 'Future booking cancellation failed: 500' };
    const store = makeStore(cycle);
    const momence = { cancelFutureBookings: async () => { throw new Error('down'); } };

    const result = await retryFailedCycles(store, momence);

    assert.equal(result.failedCount, 1);
    assert.deepEqual(store.increments, ['c3']);
});

test('startOfTodayIST returns IST midnight regardless of server timezone', () => {
    // 2026-05-27 20:00 UTC == 2026-05-28 01:30 IST -> IST midnight is 2026-05-27 18:30 UTC
    assert.equal(startOfTodayIST(new Date('2026-05-27T20:00:00Z')).toISOString(), '2026-05-27T18:30:00.000Z');
    // 2026-05-27 10:00 UTC == 15:30 IST same day
    assert.equal(startOfTodayIST(new Date('2026-05-27T10:00:00Z')).toISOString(), '2026-05-26T18:30:00.000Z');
});
