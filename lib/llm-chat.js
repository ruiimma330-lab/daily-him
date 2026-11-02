'use strict';

// One DeepSeek chat attempt waits 25s. A retryable failure tries once more.
// The whole call stays inside about 55s. This does not call any speech service.

const ATTEMPT_MS = 25000;
const DEADLINE_MS = 55000;

function isTimeout(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const cause = err.cause;
  return Boolean(cause && typeof cause === 'object' && (cause.name === 'TimeoutError' || cause.name === 'AbortError'));
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function contentOf(data) {
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  return typeof content === 'string' ? content : '';
}

async function requestChatCompletion({ fetchImpl, url, headers, body, accept, attemptMs = ATTEMPT_MS, deadlineMs = DEADLINE_MS }) {
  const started = Date.now();
  let reason = 'empty';
  let calls = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const left = deadlineMs - (Date.now() - started);
    if (attempt > 0 && left < 50) break;
    const timeoutMs = Math.max(50, Math.min(attemptMs, left));
    calls += 1;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (isRetryableStatus(response.status)) {
        reason = String(response.status);
        continue;
      }
      if (!response.ok) return { ok: false, retryable: false, reason: String(response.status), calls };
      let data;
      try {
        data = await response.json();
      } catch (err) {
        if (isTimeout(err)) {
          reason = 'timeout';
          continue;
        }
        reason = 'bad-json';
        continue;
      }
      const content = contentOf(data).trim();
      if (!content || (accept && !accept(content))) {
        reason = 'empty';
        continue;
      }
      return { ok: true, content, calls };
    } catch (err) {
      reason = isTimeout(err) ? 'timeout' : 'network';
    }
  }
  return { ok: false, retryable: true, reason, calls };
}

module.exports = { requestChatCompletion, isRetryableStatus, isTimeout, ATTEMPT_MS, DEADLINE_MS };
