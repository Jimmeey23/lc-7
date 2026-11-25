const { EventEmitter } = require('events');
const util = require('util');
const { AsyncLocalStorage } = require('async_hooks');

// Keeps the last N console lines in memory and broadcasts new ones, so the
// dashboard can show live processing. Each line is tagged with the location whose
// work produced it (via withLogContext).
const MAX_LINES = Number(process.env.LOG_BUFFER_LINES) || 1500;
const bus = new EventEmitter();
bus.setMaxListeners(100);
const lines = [];
const context = new AsyncLocalStorage();
let seq = 0;
let installed = false;

function push(level, args) {
    const message = util.format(...args);
    const entry = {
        id: ++seq,
        at: new Date().toISOString(),
        level,
        location: context.getStore()?.location || '',
        source: context.getStore()?.source || '',
        message: message.length > 4000 ? `${message.slice(0, 4000)}…` : message
    };
    lines.push(entry);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    bus.emit('line', entry);
}

function install() {
    if (installed) return;
    installed = true;
    for (const level of ['log', 'info', 'warn', 'error']) {
        const original = console[level].bind(console);
        console[level] = (...args) => {
            original(...args);
            try {
                push(level === 'info' ? 'log' : level, args);
            } catch {
                // logging must never break processing
            }
        };
    }
}

function withLogContext(info, fn) {
    return context.run(info, fn);
}

function recent({ location, since = 0, limit = 500 } = {}) {
    return lines
        .filter(line => line.id > since && (!location || !line.location || line.location === location))
        .slice(-limit);
}

function emitEvent(type, data) {
    bus.emit('event', { type, data, at: new Date().toISOString() });
}

module.exports = { bus, emitEvent, install, recent, withLogContext };
