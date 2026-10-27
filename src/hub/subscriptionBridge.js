'use strict';

const { emptySubscriptionDocument } = require('../shared/subscriptionDisplay');

function createSubscriptionBridge({ url, readToken, writeToken, onChange = () => {}, request = fetch }) {
  let current = emptySubscriptionDocument();
  let pending = null;
  let checkedAt = 0;
  let lane = Promise.resolve();

  function enqueue(run) {
    const operation = lane.then(run, run);
    lane = operation.catch(() => {});
    return operation;
  }

  async function send(method, body) {
    let response;
    try {
      response = await request(url, {
        method, redirect: 'error',
        headers: { authorization: `Bearer ${method === 'GET' ? readToken : writeToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000)
      });
    } catch (_) {
      throw Object.assign(new Error('Subscription service unavailable'), { status: 502 });
    }
    let document;
    try { document = await response.json(); } catch (_) {
      throw Object.assign(new Error('Invalid subscription service response'), { status: 502 });
    }
    if (!response.ok && response.status !== 409) {
      throw Object.assign(new Error('Subscription service rejected the request'),
        { status: [400, 413, 422, 429].includes(response.status) ? response.status : 502 });
    }
    if (!Array.isArray(document.subscriptions) || typeof document.updatedAt !== 'string') {
      throw Object.assign(new Error('Invalid subscription service document'), { status: 502 });
    }
    const previous = current.updatedAt;
    current = { version: 1, updatedAt: document.updatedAt, subscriptions: document.subscriptions };
    checkedAt = Date.now();
    if (current.updatedAt !== previous) onChange();
    if (response.status === 409) {
      throw Object.assign(new Error('stale_write'), { code: 'stale_write', current });
    }
    return current;
  }

  function read(force = false) {
    if (pending) return pending;
    if (!force && Date.now() - checkedAt < 30000) return Promise.resolve(current);
    pending = enqueue(() => send('GET')).finally(() => { pending = null; });
    return pending;
  }

  function write(body) {
    // Reads and writes share a lane so an older read cannot replace an accepted write.
    return enqueue(() => send('PUT', body));
  }

  return { read, write, current: () => current };
}

module.exports = { createSubscriptionBridge };
