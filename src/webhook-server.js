const http = require('http');
const { withLock } = require('./lock');
const { formatRunTimestamp } = require('./date-utils');
const {
    buildWebhookRunLog,
    isLateCancellationEvent,
    processLateCancellation,
    verifyWebhook
} = require('./webhook');

const MAX_BODY_BYTES = 1024 * 1024;
const RECENT_REQUEST_IDS_LIMIT = 2000;

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

// deps.createContext() -> { store, momence, momenceV2, emailService, config, helpers }
// Created once per queue drain so a burst of webhooks shares one Sheets session.
function createWebhookQueue(deps) {
    const queue = [];
    const recentRequestIds = new Set();
    let draining = null;

    function rememberRequestId(id) {
        if (!id) return true;
        if (recentRequestIds.has(id)) return false;
        recentRequestIds.add(id);
        if (recentRequestIds.size > RECENT_REQUEST_IDS_LIMIT) {
            recentRequestIds.delete(recentRequestIds.values().next().value);
        }
        return true;
    }

    async function drain() {
        await withLock(async () => {
            let context = null;
            while (queue.length > 0) {
                const verified = queue.shift();
                const startedAt = formatRunTimestamp();
                try {
                    if (!context) context = await deps.createContext();
                    const result = await processLateCancellation(verified, context);
                    console.log(`📨 Webhook member ${result.memberId} booking ${result.sessionBookingId}: ${result.outcome}`);
                    await context.store.appendRunLog(buildWebhookRunLog(verified, result, startedAt));
                } catch (error) {
                    console.error(`💥 Webhook processing failed for booking ${verified.payload?.sessionBookingId}: ${error.stack || error.message}`);
                    try {
                        if (context) await context.store.appendRunLog(buildWebhookRunLog(verified, null, startedAt, error));
                    } catch (logError) {
                        console.error(`Could not write webhook failure to RunLog: ${logError.message}`);
                    }
                    // Missed webhooks are caught by the hourly scheduled run.
                    context = null;
                }
            }
        });
    }

    function kick() {
        if (draining || queue.length === 0) return;
        draining = drain().finally(() => {
            draining = null;
            kick(); // items that arrived after the loop finished
        });
    }

    function enqueue(verified) {
        if (!rememberRequestId(verified.requestId)) return false;
        queue.push(verified);
        kick();
        return true;
    }

    return {
        enqueue,
        idle: () => draining, // null when nothing is processing
        size: () => queue.length
    };
}

function createWebhookServer({ config, queue, path = '/webhooks/momence' }) {
    return http.createServer(async (req, res) => {
        const send = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };

        try {
            const url = new URL(req.url, 'http://localhost');
            if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
                return send(200, { ok: true, queued: queue.size() });
            }
            if (url.pathname !== path) return send(404, { error: 'Not found' });
            if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });

            const rawBody = await readBody(req);
            const verified = verifyWebhook({
                headers: req.headers,
                rawBody,
                secret: config.webhook.secret,
                enforceSignature: config.webhook.enforceSignature
            });
            if (!verified.ok) {
                console.warn(`Webhook rejected (${verified.status}): ${verified.reason}`);
                return send(verified.status, { error: verified.reason });
            }

            if (!isLateCancellationEvent(verified)) {
                return send(200, { ok: true, ignored: true, event: verified.event });
            }

            const accepted = queue.enqueue(verified);
            return send(200, { ok: true, queued: accepted, duplicate: !accepted });
        } catch (error) {
            console.error(`Webhook handler error: ${error.message}`);
            return send(error.statusCode || 500, { error: error.statusCode ? error.message : 'Internal error' });
        }
    });
}

module.exports = { createWebhookQueue, createWebhookServer };
