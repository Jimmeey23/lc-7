const { GoogleSpreadsheet } = require('google-spreadsheet');
const { OAuth2Client } = require('google-auth-library');
const { getConfig, secretStatus, HOST_ID, LC7_TAG_ID, P57_TAG_ID, MOMENCE_CURRENCY, LOCATION_NAME } = require('./config');

// Extra locations (cities/studios) live in a "Locations" tab of the default
// location's Google Sheet. Only non-secret settings are stored there; secrets come
// from env vars named with the location's envPrefix (see config.js).
const LOCATIONS_TAB = 'Locations';
const LOCATION_FIELDS = [
    'id', 'name', 'enabled', 'hostId', 'lc7TagId', 'p57TagId', 'currency', 'sheetId',
    'envPrefix', 'mailFrom', 'mailFromName', 'mailReplyTo', 'templateAUuid',
    'templateBUuid', 'signatureName', 'dryRun', 'createdAt', 'updatedAt'
];

function defaultLocation() {
    return {
        id: 'default',
        name: LOCATION_NAME === 'default' ? 'Primary location' : LOCATION_NAME,
        enabled: true,
        hostId: HOST_ID,
        lc7TagId: LC7_TAG_ID,
        p57TagId: P57_TAG_ID,
        currency: MOMENCE_CURRENCY,
        sheetId: process.env.LC7_LIFECYCLE_SHEET_ID || '',
        envPrefix: '',
        isDefault: true
    };
}

function normaliseLocation(input) {
    const loc = {};
    for (const field of LOCATION_FIELDS) {
        const value = input[field];
        loc[field] = value === undefined || value === null ? '' : String(value).trim();
    }
    loc.enabled = !['false', '0', 'no', ''].includes(String(input.enabled ?? 'true').toLowerCase());
    loc.dryRun = ['true', '1', 'yes'].includes(String(input.dryRun ?? '').toLowerCase());
    if (loc.envPrefix && !loc.envPrefix.endsWith('_')) loc.envPrefix += '_';
    loc.envPrefix = loc.envPrefix.toUpperCase();
    return loc;
}

function validateLocation(loc, existingIds = []) {
    const errors = [];
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(loc.id)) errors.push('ID must be 2-31 lowercase letters, numbers or dashes (used in the webhook URL).');
    if (loc.id === 'default') errors.push('"default" is reserved for the primary location.');
    if (existingIds.includes(loc.id)) errors.push(`A location with ID "${loc.id}" already exists.`);
    if (!loc.name) errors.push('Name is required.');
    for (const field of ['hostId', 'lc7TagId', 'p57TagId']) {
        if (!/^\d+$/.test(loc[field])) errors.push(`${field} must be a number from Momence.`);
    }
    if (loc.lc7TagId && loc.lc7TagId === loc.p57TagId) errors.push('LC-7 and P57 tag IDs must differ.');
    if (!/^[A-Za-z0-9_-]{20,}$/.test(loc.sheetId)) errors.push('Google Sheet ID looks invalid (copy it from the sheet URL).');
    if (!/^[A-Z][A-Z0-9_]*_$/.test(loc.envPrefix)) errors.push('Env prefix is required, e.g. BLR_ (letters, numbers, underscore).');
    return errors;
}

function createLocationRegistry(baseConfig = getConfig()) {
    let docPromise = null;
    let cache = null;
    let cacheAt = 0;
    const TTL_MS = 60 * 1000;

    async function getSheet() {
        if (!docPromise) {
            docPromise = (async () => {
                const auth = new OAuth2Client({
                    clientId: baseConfig.googleClientId,
                    clientSecret: baseConfig.googleClientSecret,
                    redirectUri: 'urn:ietf:wg:oauth:2.0:oob'
                });
                auth.setCredentials({ refresh_token: baseConfig.googleRefreshToken });
                const doc = new GoogleSpreadsheet(baseConfig.sheetId, auth);
                await doc.loadInfo();
                return doc;
            })().catch(error => {
                docPromise = null;
                throw error;
            });
        }
        const doc = await docPromise;
        let sheet = doc.sheetsByTitle[LOCATIONS_TAB];
        if (!sheet) sheet = await doc.addSheet({ title: LOCATIONS_TAB, headerValues: LOCATION_FIELDS });
        return sheet;
    }

    async function listExtra(force = false) {
        if (!force && cache && Date.now() - cacheAt < TTL_MS) return cache;
        const sheet = await getSheet();
        const rows = await sheet.getRows();
        cache = rows.map(row => {
            const raw = {};
            for (const field of LOCATION_FIELDS) raw[field] = row.get(field);
            return normaliseLocation(raw);
        }).filter(loc => loc.id);
        cacheAt = Date.now();
        return cache;
    }

    async function list(force = false) {
        return [defaultLocation(), ...(await listExtra(force))];
    }

    // The primary location never needs the Locations tab, so its webhooks and runs
    // keep working even if that tab cannot be read.
    async function get(id) {
        if (id === 'default') return defaultLocation();
        return (await listExtra()).find(loc => loc.id === id) || null;
    }

    async function create(input) {
        const loc = normaliseLocation(input);
        const existing = (await listExtra(true)).map(item => item.id);
        const errors = validateLocation(loc, existing);
        if (errors.length) throw Object.assign(new Error(errors.join(' ')), { statusCode: 400 });
        const now = new Date().toISOString();
        loc.createdAt = now;
        loc.updatedAt = now;
        const sheet = await getSheet();
        await sheet.addRow({ ...loc, enabled: String(loc.enabled), dryRun: String(loc.dryRun) });
        cache = null;
        return loc;
    }

    async function update(id, input) {
        if (id === 'default') throw Object.assign(new Error('The primary location is configured with Railway environment variables.'), { statusCode: 400 });
        const sheet = await getSheet();
        const rows = await sheet.getRows();
        const row = rows.find(item => item.get('id') === id);
        if (!row) throw Object.assign(new Error(`Location ${id} not found`), { statusCode: 404 });
        const current = {};
        for (const field of LOCATION_FIELDS) current[field] = row.get(field);
        const loc = normaliseLocation({ ...current, ...input, id });
        const errors = validateLocation(loc, []).filter(error => !error.includes('already exists'));
        if (errors.length) throw Object.assign(new Error(errors.join(' ')), { statusCode: 400 });
        loc.updatedAt = new Date().toISOString();
        for (const field of LOCATION_FIELDS) {
            if (field === 'id' || field === 'createdAt') continue;
            row.set(field, typeof loc[field] === 'boolean' ? String(loc[field]) : loc[field]);
        }
        await row.save();
        cache = null;
        return loc;
    }

    async function remove(id) {
        if (id === 'default') throw Object.assign(new Error('The primary location cannot be removed.'), { statusCode: 400 });
        const sheet = await getSheet();
        const rows = await sheet.getRows();
        const row = rows.find(item => item.get('id') === id);
        if (!row) throw Object.assign(new Error(`Location ${id} not found`), { statusCode: 404 });
        await row.delete();
        cache = null;
    }

    return { list, get, create, update, remove };
}

// Config for a location; null location → default env config. Never throws for
// missing secrets of extra locations here: callers catch getConfig errors.
function configForLocation(location) {
    return location && location.id !== 'default' ? getConfig(location) : getConfig();
}

function describeLocation(location) {
    const base = process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
    const webhookPath = location.id === 'default'
        ? (process.env.WEBHOOK_PATH || '/webhooks/momence')
        : `${process.env.WEBHOOK_PATH || '/webhooks/momence'}/${location.id}`;
    const secrets = secretStatus(location.isDefault ? {} : location);
    return {
        ...location,
        webhookUrl: base ? `${base}${webhookPath}` : webhookPath,
        secrets,
        ready: secrets.filter(item => item.required).every(item => item.set) && Boolean(location.sheetId)
    };
}

module.exports = {
    LOCATION_FIELDS,
    configForLocation,
    createLocationRegistry,
    defaultLocation,
    describeLocation,
    normaliseLocation,
    validateLocation
};
