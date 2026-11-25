const axios = require('axios');

function getTagsFromResponse(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.customerTags)) return data.customerTags;
    if (Array.isArray(data?.payload)) return data.payload;
    if (Array.isArray(data?.tags)) return data.tags;
    if (Array.isArray(data?.data)) return data.data;
    return [];
}

// Midnight today in IST (UTC+05:30), independent of the server's local timezone.
function startOfTodayIST(now = new Date()) {
    const IST_OFFSET_MS = 330 * 60 * 1000;
    const shifted = new Date(now.getTime() + IST_OFFSET_MS);
    return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - IST_OFFSET_MS);
}

function createMomenceClient(config) {
    const headers = {
        Authorization: `Bearer ${config.accessToken}`,
        Cookie: config.allCookies,
        Accept: 'application/json',
        'Content-Type': 'application/json'
    };

    const api = axios.create({ headers, timeout: 30000 });

    const rateLimitMs = config.momenceRateLimitMs || 200;
    let lastCallAt = 0;

    async function throttle() {
        const now = Date.now();
        const gap = now - lastCallAt;
        if (gap < rateLimitMs) {
            await new Promise(resolve => setTimeout(resolve, rateLimitMs - gap));
        }
        lastCallAt = Date.now();
    }

    async function requestWithRetry(fn, retries = 3, baseDelayMs = 2000) {
        await throttle();
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                const status = error.response?.status;
                if (status === 401 || status === 403) {
                    // Expired/invalid Momence token or cookies: retrying cannot help.
                    error.message = `Momence auth rejected (${status}) — refresh MOMENCE_ACCESS_TOKEN / MOMENCE_ALL_COOKIES. ${error.message}`;
                    throw error;
                }
                if (attempt >= retries || status === 404 || status === 400 || status === 422) {
                    throw error;
                }
                if (status === 429) {
                    const retryAfter = Number(error.response?.headers?.['retry-after']) || 60;
                    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                    continue;
                }
                const jitter = Math.floor(Math.random() * 500);
                await new Promise(resolve => setTimeout(resolve, baseDelayMs * (attempt + 1) + jitter));
            }
        }
    }

    async function startLateCancellationReport(lookbackDays = 30) {
        const url = `https://api.momence.com/host/${config.hostId}/reports/late-cancellations/async`;
        const safeDays = Math.max(lookbackDays, 14);
        const endDate = new Date();
        const startDate = new Date(endDate.getTime() - safeDays * 24 * 60 * 60 * 1000);

        const payload = {
            timeZone: 'Asia/Kolkata',
            groupRecurring: false,
            computedSaleValue: true,
            includeVatInRevenue: true,
            useBookedEntityDateRange: false,
            excludeMembershipRenews: false,
            day: endDate.toISOString(),
            moneyCreditSalesFilter: 'filterOutSalesPaidByMoneyCredits',
            hideVoided: false,
            excludeInactiveMembers: false,
            includeRefunds: false,
            showOnlySpotfillerRevenue: false,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            startDate2: startDate.toISOString(),
            endDate2: endDate.toISOString(),
            datePreset: -1,
            datePreset2: 4
        };

        const response = await requestWithRetry(() => api.post(url, payload));
        if (!response.data?.reportRunId) {
            throw new Error(`No reportRunId returned: ${JSON.stringify(response.data)}`);
        }
        return response.data.reportRunId;
    }

    async function fetchLateCancellationReport(reportRunId) {
        const url = `https://api.momence.com/host/${config.hostId}/reports/late-cancellations/report-runs/${reportRunId}`;
        const maxAttempts = config.reportPollAttempts || 40;
        const intervalMs = config.reportPollIntervalMs || 3000;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const response = await requestWithRetry(() => api.get(url));
            const items = response.data?.reportData?.items;
            if (response.data?.status === 'completed' || items) {
                return items || [];
            }
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
        throw new Error(`Late-cancellation report ${reportRunId} did not complete after ${maxAttempts} attempts`);
    }

    async function fetchLateCancellations(lookbackDays) {
        const reportRunId = await startLateCancellationReport(lookbackDays);
        return fetchLateCancellationReport(reportRunId);
    }

    async function assignLc7Tag(memberId) {
        if (config.dryRun) return { success: true, dryRun: true };
        const url = `https://api.momence.com/host/${config.hostId}/tags/assign`;
        const payload = {
            tagIds: [config.lc7TagId],
            type: 'customer',
            entityId: Number(memberId)
        };
        await requestWithRetry(() => api.post(url, payload));
        return { success: true };
    }

    async function assignTags(memberId, tagIds) {
        if (config.dryRun) return { success: true, dryRun: true };
        const url = `https://momence.com/_api/primary/host/${config.hostId}/tags/assign`;
        const payload = {
            tagIds,
            type: 'customer',
            entityId: Number(memberId)
        };
        await requestWithRetry(() => api.post(url, payload));
        return { success: true };
    }

    async function fetchMemberTags(memberId) {
        const url = `https://momence.com/_api/primary/host/${config.hostId}/customers/${memberId}/tags`;
        const response = await requestWithRetry(() => api.get(url));
        return getTagsFromResponse(response.data);
    }

    async function fetchMemberHistory(memberId) {
        const url = `https://readonly-api.momence.com/host/${config.hostId}/customers/${memberId}/history`;
        const response = await requestWithRetry(() => api.get(url));
        return response.data || [];
    }

    async function fetchLc7Members() {
        const filters = encodeURIComponent(JSON.stringify({
            type: 'and',
            customerTags: {
                type: null,
                tags: [config.lc7TagId],
                customerHaveTag: 'have'
            }
        }));
        const pageSize = 200;
        const maxPages = 50;
        const members = [];
        for (let page = 0; page < maxPages; page++) {
            const url = `https://api.momence.com/host/${config.hostId}/customers?filters=${filters}&query=&page=${page}&pageSize=${pageSize}`;
            const response = await requestWithRetry(() => api.get(url));
            const batch = response.data?.payload || [];
            members.push(...batch);
            if (batch.length < pageSize) break;
        }
        return members;
    }

    async function cancelBooking(memberId, booking) {
        if (config.dryRun) return { success: true, bookingId: booking.bookingId, dryRun: true };
        const url = `https://api.momence.com/host/${config.hostId}/session-bookings/${booking.bookingId}/cancel`;
        const payload = {
            memberId: Number(memberId),
            sessionId: booking.sessionId,
            refund: true,
            currency: config.currency || 'inr',
            disableNotifications: true,
            isLateCancellation: false,
            cancelMemberPaymentPlanInstallments: false
        };
        await requestWithRetry(() => api.post(url, payload));
        return { success: true, bookingId: booking.bookingId };
    }

    async function cancelFutureBookings(memberId) {
        const today = startOfTodayIST();
        const history = await fetchMemberHistory(memberId);
        const futureBookings = history.filter(item =>
            item.type === 'session' &&
            item.startsAt &&
            new Date(item.startsAt) >= today &&
            !item.deletedAt &&
            !item.isVoided
        );

        const results = [];
        for (const booking of futureBookings) {
            try {
                results.push(await cancelBooking(memberId, booking));
            } catch (error) {
                results.push({
                    success: false,
                    bookingId: booking.bookingId,
                    error: error.response?.status || error.message
                });
            }
        }

        return {
            total: futureBookings.length,
            successful: results.filter(result => result.success).length,
            failed: results.filter(result => !result.success),
            bookingIds: futureBookings.map(booking => booking.bookingId)
        };
    }

    return {
        tagIds: { lc7: Number(config.lc7TagId), p57: Number(config.p57TagId) },
        assignLc7Tag,
        assignTags,
        cancelFutureBookings,
        fetchLateCancellations,
        fetchLc7Members,
        fetchMemberHistory,
        fetchMemberTags
    };
}

module.exports = {
    createMomenceClient,
    startOfTodayIST
};
