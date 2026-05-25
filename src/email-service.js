const crypto = require('crypto');
const axios = require('axios');
const { formatRunTimestamp, parseDate } = require('./date-utils');

const EMAIL_POLICY_CUTOFF_AT = new Date('2026-05-24T18:30:00.000Z');

const TEMPLATE_A_SUBJECT = 'Booking Privileges Paused for 7 Days (Late Cancellations)';
const TEMPLATE_B_SUBJECT = 'Notification: Your Booking Privileges Are Now Restored';

function makeEmailId(template, cycle, relatedDate = '') {
    return crypto
        .createHash('sha1')
        .update([template, cycle.cycleId, cycle.memberId, relatedDate].join('|'))
        .digest('hex');
}

function getFirstName(cycle) {
    const name = String(cycle.memberName || '').trim();
    if (!name) return 'there';
    return name.split(/\s+/)[0];
}

function areAllTriggerDatesOnOrAfterEmailCutoff(cycle) {
    const dates = Array.isArray(cycle.triggerWindowDates)
        ? cycle.triggerWindowDates
        : String(cycle.triggerWindowDates || '').split('|').map(value => value.trim()).filter(Boolean);
    if (dates.length < 3) return false;
    return dates.slice(0, 3).every(value => {
        const date = parseDate(value);
        return date && date >= EMAIL_POLICY_CUTOFF_AT;
    });
}

function isRemovalDateOnOrAfterEmailCutoff(cycle) {
    const date = parseDate(cycle.p57EligibleAt);
    return Boolean(date && date >= EMAIL_POLICY_CUTOFF_AT);
}

function shouldSendTemplateA(cycle) {
    return Boolean(cycle.memberEmail && areAllTriggerDatesOnOrAfterEmailCutoff(cycle));
}

function shouldSendTemplateB(cycle) {
    return Boolean(cycle.memberEmail && isRemovalDateOnOrAfterEmailCutoff(cycle));
}

function buildTemplateA(cycle) {
    const firstName = getFirstName(cycle);
    return {
        subject: TEMPLATE_A_SUBJECT,
        text: `Hi ${firstName},

We truly value your dedication to your workouts with us and the positive energy you bring to our community. At the same time, it's important for us to make sure every member has a fair chance to attend their favorite classes.

We noticed that there have been more than two late cancellations on your account in the past 7 days. As per our policy, your advance booking privileges will be temporarily paused for 7 days. This process also includes the automatic cancellation of any existing future bookings you may have scheduled.

During this period, you are still very welcome to continue classes - simply walk in and join, subject to spot availability.

We kindly ask that you please:

Cancel in advance whenever possible if you're unable to make it.

Avoid booking multiple classes a day unless you're certain you can attend them.

Thank you for helping us keep our community fair and respectful for all members. We look forward to seeing you in class soon!

With gratitude,
Team Physique 57`
    };
}

function buildTemplateB(cycle) {
    const firstName = getFirstName(cycle);
    return {
        subject: TEMPLATE_B_SUBJECT,
        text: `Hi ${firstName},

We're happy to let you know that your class booking privileges have now been restored. You can once again reserve your favorite classes in advance as usual.

We truly appreciate your understanding of our late cancellation policy, which helps ensure all members get a fair chance to attend the classes they love. Thank you for being a part of keeping our community balanced and respectful.

We look forward to seeing you in class soon!

With gratitude,
Team Physique 57`
    };
}

function createEmailService(config, httpClient = axios) {
    async function sendMail(message, cycle) {
        return httpClient.post(
            config.mail.apiUrl,
            {
                from: {
                    email: config.mail.from,
                    name: 'Team Physique 57'
                },
                to: [{ email: cycle.memberEmail }],
                subject: message.subject,
                text: message.text
            },
            {
                headers: {
                    Authorization: `Bearer ${config.mail.apiToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );
    }

    async function sendLifecycleEmail(store, cycle, template) {
        const message = template === 'A' ? buildTemplateA(cycle) : buildTemplateB(cycle);
        const relatedDate = template === 'A' ? cycle.latestLateCancellationAt : cycle.p57EligibleAt;
        const emailId = makeEmailId(template, cycle, relatedDate);

        if (await store.hasSentEmail(emailId)) {
            return { sent: false, skipped: true, emailId };
        }

        const logBase = {
            emailId,
            cycleId: cycle.cycleId,
            memberId: cycle.memberId,
            memberEmail: cycle.memberEmail,
            template,
            subject: message.subject,
            relatedDate
        };

        try {
            if (!config.dryRun) {
                await sendMail(message, cycle);
            }
            await store.appendEmailLog({
                ...logBase,
                status: config.dryRun ? 'DRY_RUN' : 'SENT',
                sentAt: formatRunTimestamp()
            });
            return { sent: !config.dryRun, dryRun: config.dryRun, emailId };
        } catch (error) {
            await store.appendEmailLog({
                ...logBase,
                status: 'FAILED',
                sentAt: formatRunTimestamp(),
                error: error.message
            });
            throw error;
        }
    }

    async function sendTemplateA(store, cycle) {
        if (!shouldSendTemplateA(cycle)) return { sent: false, skipped: true };
        return sendLifecycleEmail(store, cycle, 'A');
    }

    async function sendTemplateB(store, cycle) {
        if (!shouldSendTemplateB(cycle)) return { sent: false, skipped: true };
        return sendLifecycleEmail(store, cycle, 'B');
    }

    return {
        sendTemplateA,
        sendTemplateB
    };
}

module.exports = {
    EMAIL_POLICY_CUTOFF_AT,
    TEMPLATE_A_SUBJECT,
    TEMPLATE_B_SUBJECT,
    areAllTriggerDatesOnOrAfterEmailCutoff,
    buildTemplateA,
    buildTemplateB,
    createEmailService,
    getFirstName,
    isRemovalDateOnOrAfterEmailCutoff,
    makeEmailId,
    shouldSendTemplateA,
    shouldSendTemplateB
};
