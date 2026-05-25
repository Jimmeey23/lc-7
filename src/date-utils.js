function parseDate(value) {
    if (!value) return null;
    if (typeof value === 'string') {
        const match = value.match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
        if (match) {
            const [, day, month, year, hour, minute, second] = match;
            const utcMs = Date.UTC(
                Number(year),
                Number(month) - 1,
                Number(day),
                Number(hour) - 5,
                Number(minute) - 30,
                Number(second)
            );
            return new Date(utcMs);
        }
    }
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value) {
    const date = parseDate(value);
    return date ? date.toISOString() : '';
}

function ageDaysSince(value, now = new Date()) {
    const date = parseDate(value);
    if (!date) return null;
    return (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);
}

function isMoreThanDaysOld(value, days, now = new Date()) {
    const ageDays = ageDaysSince(value, now);
    return ageDays !== null && ageDays > days;
}

function formatRunTimestamp(date = new Date()) {
    return formatIST(date);
}

function formatIST(value = new Date()) {
    const date = parseDate(value);
    if (!date) return '';

    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

module.exports = {
    ageDaysSince,
    formatIST,
    formatRunTimestamp,
    isMoreThanDaysOld,
    parseDate,
    toIso
};
