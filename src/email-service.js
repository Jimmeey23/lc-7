const crypto = require('crypto');
const axios = require('axios');
const { formatRunTimestamp, parseDate } = require('./date-utils');

const EMAIL_POLICY_CUTOFF_AT = new Date('2026-05-24T18:30:00.000Z');

const TEMPLATE_A_SUBJECT = 'Booking Privileges Paused for 7 Days (Late Cancellations)';
const TEMPLATE_B_SUBJECT = 'Notification: Your Booking Privileges Are Now Restored';

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildMailto(replyTo, subject) {
    return `mailto:${replyTo}?subject=${encodeURIComponent(subject)}`;
}

function buildHtmlEmail({ firstName, bodyHtml, ctaLabel, ctaHref }) {
    return `<!doctype html>
<html>
<body style="margin:0;background:#f3f3f3;padding:0;font-family:Arial,Helvetica,sans-serif;color:#282a2d;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f3f3;margin:0;padding:0;">
    <tr>
      <td align="center" style="padding:0;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:760px;background:#ffffff;margin:0 auto;">
          <tr>
            <td style="padding:48px 64px 44px 64px;font-size:20px;line-height:1.42;">
              <p style="margin:0 0 72px 0;font-size:20px;line-height:1.42;font-weight:700;">Hi ${escapeHtml(firstName)},</p>
              ${bodyHtml}
              <p style="margin:72px 0 52px 0;font-size:20px;line-height:1.42;">With gratitude,<br><strong>Team Physique 57</strong></p>
              <table role="presentation" cellspacing="0" cellpadding="0" align="center" style="margin:0 auto;">
                <tr>
                  <td align="center" bgcolor="#06384c" style="border-radius:5px;">
                    <a href="${ctaHref}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-size:18px;line-height:1.2;border-radius:5px;background:#06384c;">${escapeHtml(ctaLabel)}</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

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

function buildTemplateA(cycle, replyTo = 'latecancellations@physique57india.com') {
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
Team Physique 57`,
        html: buildHtmlEmail({
            firstName,
            ctaLabel: 'This is a mistake',
            ctaHref: buildMailto(replyTo, 'LC-7 late cancellation review request'),
            bodyHtml: `
              <p style="margin:0 0 72px 0;font-size:20px;line-height:1.42;">We truly value your dedication to your workouts with us and the positive energy you bring to our community. At the same time, it's important for us to make sure every member has a fair chance to attend their favorite classes.</p>
              <p style="margin:0 0 72px 0;font-size:20px;line-height:1.42;">We noticed that there have been more than two late cancellations on your account in the past 7 days. As per our policy, your <strong>advance booking privileges will be temporarily paused for 7 days</strong>. This process also includes the automatic cancellation of any existing future bookings you may have scheduled.</p>
              <p style="margin:0 0 72px 0;font-size:20px;line-height:1.42;">During this period, you are still very welcome to continue classes - simply <strong>walk in and join, subject to spot availability.</strong></p>
              <p style="margin:0 0 22px 0;font-size:20px;line-height:1.42;">We kindly ask that you please:</p>
              <ul style="margin:0 0 24px 26px;padding:0;font-size:20px;line-height:1.42;">
                <li style="margin:0 0 22px 0;">Cancel in advance whenever possible if you're unable to make it.</li>
                <li style="margin:0;">Avoid booking multiple classes a day unless you're certain you can attend them.</li>
              </ul>
              <p style="margin:28px 0 0 0;font-size:20px;line-height:1.42;">Thank you for helping us keep our community fair and respectful for all members. We look forward to seeing you in class soon!</p>`
        })
    };
}

function buildTemplateB(cycle, replyTo = 'latecancellations@physique57india.com') {
    const firstName = getFirstName(cycle);
    return {
        subject: TEMPLATE_B_SUBJECT,
        text: `Hi ${firstName},

We're happy to let you know that your class booking privileges have now been restored. You can once again reserve your favorite classes in advance as usual.

We truly appreciate your understanding of our late cancellation policy, which helps ensure all members get a fair chance to attend the classes they love. Thank you for being a part of keeping our community balanced and respectful.

We look forward to seeing you in class soon!

With gratitude,
Team Physique 57`,
        html: buildHtmlEmail({
            firstName,
            ctaLabel: 'Reply to this email',
            ctaHref: buildMailto(replyTo, 'Question about restored booking privileges'),
            bodyHtml: `
              <p style="margin:0 0 72px 0;font-size:20px;line-height:1.42;">We're happy to let you know that your <strong>class booking privileges have now been restored</strong>. You can once again reserve your favorite classes in advance as usual.</p>
              <p style="margin:0 0 72px 0;font-size:20px;line-height:1.42;">We truly appreciate your understanding of our late cancellation policy, which helps ensure all members get a fair chance to attend the classes they love. Thank you for being a part of keeping our community balanced and respectful.</p>
              <p style="margin:0;font-size:20px;line-height:1.42;">We look forward to seeing you in class soon!</p>`
        })
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
                reply_to: { email: config.mail.from },
                subject: message.subject,
                text: message.text,
                html: message.html
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
        const message = template === 'A' ? buildTemplateA(cycle, config.mail.from) : buildTemplateB(cycle, config.mail.from);
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

    async function retryFailedEmail(store, cycle, failedEmail) {
        if (!cycle.memberEmail && failedEmail.memberEmail) {
            cycle.memberEmail = failedEmail.memberEmail;
        }
        if (failedEmail.template !== 'A' && failedEmail.template !== 'B') {
            return { sent: false, skipped: true };
        }
        return sendLifecycleEmail(store, cycle, failedEmail.template);
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
        retryFailedEmail,
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
