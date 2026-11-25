// Process-wide mutex. The hourly run and webhook processing both mutate Momence
// and the Google Sheet, so they must never run at the same time.
let tail = Promise.resolve();

function withLock(fn) {
    const result = tail.then(() => fn());
    tail = result.catch(() => {});
    return result;
}

module.exports = { withLock };
