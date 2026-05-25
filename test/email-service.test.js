const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildTemplateA,
    buildTemplateB,
    createEmailService,
    getFirstName,
    shouldSendTemplateA,
    shouldSendTemplateB
} = require('../src/email-service');

function cycle(overrides = {}) {
    return {
        cycleId: 'cycle-1',
        memberId: 100,
        memberName: 'Priya Shah',
        memberEmail: 'priya@example.com',
        latestLateCancellationAt: '27-05-2026 10:00:00',
        p57EligibleAt: '03-06-2026 10:00:00',
        triggerWindowDates: [
            '25-05-2026 08:00:00',
            '26-05-2026 08:00:00',
            '27-05-2026 10:00:00'
        ],
        ...overrides
    };
}

test('shouldSendTemplateA requires all three trigger cancellations on or after May 25 IST', () => {
    assert.equal(shouldSendTemplateA(cycle()), true);
    assert.equal(shouldSendTemplateA(cycle({
        triggerWindowDates: [
            '24-05-2026 23:59:59',
            '26-05-2026 08:00:00',
            '27-05-2026 10:00:00'
        ]
    })), false);
});

test('shouldSendTemplateA skips cycles without member email', () => {
    assert.equal(shouldSendTemplateA(cycle({ memberEmail: '' })), false);
});

test('shouldSendTemplateB requires removal date on or after May 25 IST regardless of cancellation dates', () => {
    assert.equal(shouldSendTemplateB(cycle({
        p57EligibleAt: '25-05-2026 00:00:00',
        triggerWindowDates: [
            '18-05-2026 08:00:00',
            '19-05-2026 08:00:00',
            '20-05-2026 10:00:00'
        ]
    })), true);
    assert.equal(shouldSendTemplateB(cycle({ p57EligibleAt: '24-05-2026 23:59:59' })), false);
});

test('templates address the member by first name', () => {
    assert.equal(getFirstName(cycle()), 'Priya');
    assert.match(buildTemplateA(cycle()).text, /^Hi Priya,/);
    assert.match(buildTemplateB(cycle()).text, /^Hi Priya,/);
    assert.match(buildTemplateA(cycle(), 'latecancellations@physique57india.com').html, /href="mailto:latecancellations@physique57india\.com\?/);
    assert.match(buildTemplateA(cycle(), 'latecancellations@physique57india.com').html, />This is a mistake</);
    assert.match(buildTemplateB(cycle(), 'latecancellations@physique57india.com').html, />Reply to this email</);
});

test('sendTemplateA posts to Mailtrap API and logs sent email', async () => {
    const requests = [];
    const logs = [];
    const service = createEmailService({
        dryRun: false,
        mail: {
            apiUrl: 'https://sandbox.api.mailtrap.io/api/send/123',
            apiToken: 'token',
            from: 'latecancellations@physique57india.com'
        }
    }, {
        post: async (url, payload, options) => {
            requests.push({ url, payload, options });
            return { data: { success: true } };
        }
    });
    const store = {
        hasSentEmail: async () => false,
        appendEmailLog: async log => logs.push(log)
    };

    const result = await service.sendTemplateA(store, cycle());

    assert.equal(result.sent, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://sandbox.api.mailtrap.io/api/send/123');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer token');
    assert.deepEqual(requests[0].payload.from, {
        email: 'latecancellations@physique57india.com',
        name: 'Team Physique 57'
    });
    assert.deepEqual(requests[0].payload.reply_to, { email: 'latecancellations@physique57india.com' });
    assert.deepEqual(requests[0].payload.to, [{ email: 'priya@example.com' }]);
    assert.match(requests[0].payload.html, /This is a mistake/);
    assert.equal(logs[0].status, 'SENT');
});

test('retryFailedEmail resends failed emails using the original template', async () => {
    const requests = [];
    const service = createEmailService({
        dryRun: false,
        mail: {
            apiUrl: 'https://sandbox.api.mailtrap.io/api/send/123',
            apiToken: 'token',
            from: 'latecancellations@physique57india.com'
        }
    }, {
        post: async (url, payload) => {
            requests.push({ url, payload });
            return { data: { success: true } };
        }
    });
    const store = {
        hasSentEmail: async () => false,
        appendEmailLog: async () => {}
    };

    const result = await service.retryFailedEmail(store, cycle({ memberEmail: '' }), {
        template: 'A',
        memberEmail: 'fallback@example.com'
    });

    assert.equal(result.sent, true);
    assert.deepEqual(requests[0].payload.to, [{ email: 'fallback@example.com' }]);
    assert.equal(requests[0].payload.subject, 'Booking Privileges Paused for 7 Days (Late Cancellations)');
});
