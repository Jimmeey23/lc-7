const axios = require('axios');

const V2_BASE_URL = 'https://api.momence.com/api/v2';

// Membership details are not in the documented HostMemberSessionBookingDto, so look
// for any membership name Momence includes in the booking object (undocumented
// fields). Returns '' when none is present; callers then fall back to the report.
function extractMembershipName(booking) {
    if (!booking || typeof booking !== 'object') return '';

    const direct = [
        booking.membershipName,
        booking.boughtMembershipName,
        booking.paidWithMembershipName,
        booking.boughtMembership?.membership?.name,
        booking.boughtMembership?.name,
        booking.membership?.name,
        booking.paidWith?.boughtMembership?.membership?.name,
        booking.paidWith?.boughtMembership?.name,
        booking.paidWith?.membership?.name,
        booking.payment?.boughtMembership?.membership?.name,
        booking.payment?.boughtMembership?.name
    ].find(value => typeof value === 'string' && value.trim());
    if (direct) return direct.trim();

    // Bounded deep search: any object under a key containing "membership" that has a name.
    const seen = new Set();
    function search(value, underMembership, depth) {
        if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return '';
        seen.add(value);
        if (underMembership && typeof value.name === 'string' && value.name.trim()) return value.name.trim();
        for (const [key, child] of Object.entries(value)) {
            if (key === 'session') continue; // session.name is the class name, not a membership
            const isMembershipKey = key.toLowerCase().includes('membership');
            if (isMembershipKey && typeof child === 'string' && key.toLowerCase().includes('name') && child.trim()) {
                return child.trim();
            }
            const found = search(child, underMembership || isMembershipKey, depth + 1);
            if (found) return found;
        }
        return '';
    }
    return search(booking, false, 0);
}

function createMomenceV2Client(config, httpClient = axios) {
    const auth = config.momenceV2 || {};
    let token = auth.staticToken ? { accessToken: auth.staticToken, expiresAt: Infinity, refreshToken: null } : null;

    function usesPasswordGrant() {
        return Boolean(auth.clientId && auth.clientSecret && auth.username && auth.password);
    }

    async function requestToken(body) {
        const basic = Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64');
        const response = await httpClient.post(`${V2_BASE_URL}/auth/token`, new URLSearchParams(body).toString(), {
            headers: {
                Authorization: `Basic ${basic}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            },
            timeout: 30000
        });
        const data = response.data || {};
        const accessToken = data.access_token || data.accessToken;
        if (!accessToken) throw new Error('Momence v2 token response had no access_token');
        const expiresAt = data.accessTokenExpiresAt ? new Date(data.accessTokenExpiresAt).getTime() : Date.now() + 50 * 60 * 1000;
        token = { accessToken, expiresAt, refreshToken: data.refresh_token || data.refreshToken || null };
        return token.accessToken;
    }

    async function getAccessToken(forceRefresh = false) {
        if (!usesPasswordGrant()) {
            if (!token) throw new Error('Momence v2 auth not configured: set MOMENCE_API_CLIENT_ID/SECRET/USERNAME/PASSWORD or MOMENCE_V2_ACCESS_TOKEN');
            return token.accessToken;
        }
        const fresh = token && !forceRefresh && token.expiresAt - Date.now() > 60 * 1000;
        if (fresh) return token.accessToken;
        if (token?.refreshToken) {
            try {
                return await requestToken({ grant_type: 'refresh_token', refresh_token: token.refreshToken });
            } catch (error) {
                console.warn(`Momence v2 token refresh failed, re-authenticating: ${error.message}`);
            }
        }
        return requestToken({ grant_type: 'password', username: auth.username, password: auth.password });
    }

    async function get(path, params = {}) {
        let reauthed = false;
        for (let attempt = 0; attempt <= 3; attempt++) {
            try {
                const accessToken = await getAccessToken();
                const response = await httpClient.get(`${V2_BASE_URL}${path}`, {
                    params,
                    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
                    timeout: 30000
                });
                return response.data;
            } catch (error) {
                const status = error.response?.status;
                if (status === 401 && usesPasswordGrant() && !reauthed) {
                    reauthed = true;
                    await getAccessToken(true);
                    continue;
                }
                const retryable = !status || status === 429 || status >= 500;
                if (!retryable || attempt === 3) throw error;
                const retryAfter = Number(error.response?.headers?.['retry-after']);
                const delayMs = status === 429 && retryAfter ? retryAfter * 1000 : 1000 * (attempt + 1);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        return null;
    }

    async function getMember(memberId) {
        return get(`/host/members/${Number(memberId)}`);
    }

    // Find one booking in the member's booking list (cancelled included). Late
    // cancellations happen shortly before class, so search sessions starting from
    // 2 days before to 14 days after the cancellation, then widen if not found.
    async function findMemberBooking(memberId, sessionBookingId, cancelledAt) {
        const anchor = new Date(cancelledAt);
        const base = Number.isNaN(anchor.getTime()) ? new Date() : anchor;
        const windows = [
            [2, 14],
            [30, 90]
        ];
        for (const [daysBefore, daysAfter] of windows) {
            const startAfter = new Date(base.getTime() - daysBefore * 86400000).toISOString();
            const startBefore = new Date(base.getTime() + daysAfter * 86400000).toISOString();
            for (let page = 0; page < 20; page++) {
                const data = await get(`/host/members/${Number(memberId)}/sessions`, {
                    page,
                    pageSize: 100,
                    includeCancelled: true,
                    startAfter,
                    startBefore,
                    sortBy: 'startsAt',
                    sortOrder: 'ASC'
                });
                const items = Array.isArray(data?.payload) ? data.payload : [];
                const match = items.find(item => Number(item.id) === Number(sessionBookingId));
                if (match) return match;
                if (items.length < 100) break;
            }
        }
        return null;
    }

    return { findMemberBooking, getMember };
}

module.exports = { createMomenceV2Client, extractMembershipName };
