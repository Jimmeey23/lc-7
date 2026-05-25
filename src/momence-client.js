const axios = require('axios');

function getTagsFromResponse(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.customerTags)) return data.customerTags;
    if (Array.isArray(data?.payload)) return data.payload;
    if (Array.isArray(data?.tags)) return data.tags;
    if (Array.isArray(data?.data)) return data.data;
    return [];
}

function createMomenceClient(config) {
    const headers = {
        Authorization: `Bearer ${config.accessToken}`,
        Cookie: config.allCookies,
        Accept: 'application/json',
        'Content-Type': 'application/json'
    };

    const api = axios.create({ headers, timeout: 30000 });

    async function requestWithRetry(fn, retries = 2) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                const status = error.response?.status;
                if (attempt < retries && status !== 404) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
                    continue;
                }
                throw error;
            }
        }
    }

    async function startLateCancellationReport() {
        const url = `https://api.momence.com/host/${config.hostId}/reports/late-cancellations/async`;
        const payload = {
            timeZone: 'Asia/Kolkata',
            groupRecurring: false,
            computedSaleValue: true,
            includeVatInRevenue: true,
            useBookedEntityDateRange: false,
            excludeMembershipRenews: false,
            day: '2025-10-02T00:00:00.000Z',
            moneyCreditSalesFilter: 'filterOutSalesPaidByMoneyCredits',
            hideVoided: false,
            excludeInactiveMembers: false,
            includeRefunds: false,
            showOnlySpotfillerRevenue: false,
            startDate: '2025-09-30T18:30:00.000Z',
            endDate: '2026-12-31T18:29:00.000Z',
            startDate2: '2025-09-30T18:30:00.000Z',
            endDate2: '2026-10-31T18:29:59.999Z',
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
        for (let attempt = 1; attempt <= 10; attempt++) {
            const response = await requestWithRetry(() => api.get(url));
            const items = response.data?.reportData?.items;
            if (response.data?.status === 'completed' || items) {
                return items || [];
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        throw new Error(`Late-cancellation report ${reportRunId} did not complete`);
    }

    async function fetchLateCancellations() {
        const reportRunId = await startLateCancellationReport();
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
        const url = `https://api.momence.com/host/${config.hostId}/customers?filters=${filters}&query=&page=0&pageSize=200`;
        const response = await requestWithRetry(() => api.get(url));
        return response.data?.payload || [];
    }

    async function cancelBooking(memberId, booking) {
        if (config.dryRun) return { success: true, bookingId: booking.bookingId, dryRun: true };
        const url = `https://api.momence.com/host/${config.hostId}/session-bookings/${booking.bookingId}/cancel`;
        const payload = {
            memberId: Number(memberId),
            sessionId: booking.sessionId,
            refund: true,
            currency: 'inr',
            disableNotifications: true,
            isLateCancellation: false,
            cancelMemberPaymentPlanInstallments: false
        };
        await requestWithRetry(() => api.post(url, payload));
        return { success: true, bookingId: booking.bookingId };
    }

    async function cancelFutureBookings(memberId) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
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
    createMomenceClient
};
