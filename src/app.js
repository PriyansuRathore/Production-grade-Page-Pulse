const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pino = require('pino-http');
const crypto = require('crypto');

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || /^(fc|fd)/.test(host)) return true;
  if (!ipv4) return false;

  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return true;

  return octets[0] === 0 ||
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19));
}

function parsePublicHttpUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || isPrivateHost(parsed.hostname)) {
    throw new Error('URL must target a public http(s) host.');
  }
  return parsed;
}

async function fetchWithValidatedRedirects(initialUrl, signal) {
  let currentUrl = initialUrl;

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      signal
    });
    const location = response.headers.get('location');

    if (response.status < 300 || response.status >= 400 || !location) return response;
    currentUrl = parsePublicHttpUrl(new URL(location, currentUrl).toString()).toString();
  }

  throw new Error('Too many redirects.');
}

function createApp(options = {}) {
  const app = express();
  const logger = pino({
    genReqId: (req, res) => {
        const existingId = req.id || req.headers["x-request-id"];
        if (existingId) return existingId;
        const id = crypto.randomUUID();
        res.setHeader('x-request-id', id);
        return id;
    },
    customProps: (req, res) => ({
      requestId: req.id,
    }),
  });
  app.use(logger);

  const cacheWindowMs = options.cacheWindowMs ?? 60000;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? 60000;
  const rateLimitMax = options.rateLimitMax ?? 10;
  const timeoutMs = options.timeoutMs ?? 5000;
  const concurrencyLimit = options.concurrencyLimit ?? 4;

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  const cache = new Map();
  const requestCounts = new Map();
  const activeRequests = new Set();

  const rateLimiter = (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const window = requestCounts.get(key);

    if (!window || now - window.start > rateLimitWindowMs) {
      requestCounts.set(key, { start: now, count: 1 });
      return next();
    }

    if (window.count >= rateLimitMax) {
      req.log.warn({ ip: key }, 'Rate limit exceeded');
      return res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please try again shortly.'
        }
      });
    }

    window.count += 1;
    return next();
  };

  app.use(rateLimiter);

  app.get('/', (req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Page Pulse</title>
  </head>
  <body>
    <main>
      <h1>Page Pulse</h1>
      <p>Audit public URLs through the <code>POST /api/audit</code> endpoint.</p>
      <p>Service status: <a href="/health">health check</a></p>
    </main>
    <footer>
      <a href="https://digitalheroesco.com">Built for Digital Heroes Training Task</a>
    </footer>
  </body>
</html>`);
  });

  app.post('/api/audit', async (req, res) => {
    const { url } = req.body || {};
    let timeout;
    let auditStarted = false;
    try {
      if (typeof url !== 'string') {
        req.log.warn({ url }, 'Invalid URL received');
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'A valid http(s) URL is required.'
          }
        });
      }

      const requestedUrl = url.trim();
      let targetUrl;
      try {
        targetUrl = parsePublicHttpUrl(requestedUrl).toString();
      } catch {
        req.log.warn({ url }, 'Invalid URL received');
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'A public http(s) URL is required.'
          }
        });
      }

      const cached = cache.get(targetUrl);
      if (cached && Date.now() - cached.timestamp < cacheWindowMs) {
        req.log.info({ url: targetUrl }, 'Serving from cache');
        return res.json({
          success: true,
          result: {
            url: requestedUrl,
            statusCode: cached.statusCode,
            contentType: cached.contentType,
            bytes: cached.bytes,
            cached: true,
            requestId: req.id
          }
        });
      }

      if (activeRequests.size >= concurrencyLimit) {
        req.log.warn({ active: activeRequests.size }, 'Concurrency limit reached');
        return res.status(429).json({
          success: false,
          error: {
            code: 'CONCURRENCY_LIMITED',
            message: 'Too many audits running at the moment.'
          }
        });
      }

      req.log.info({ url: targetUrl }, 'Starting audit');
      activeRequests.add(req.id);
      auditStarted = true;
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetchWithValidatedRedirects(targetUrl, controller.signal);
      const contentType = response.headers.get('content-type') || 'unknown';
      const bodyText = await response.text();
      const bytes = Buffer.byteLength(bodyText || '', 'utf8');

      const payload = {
        url: requestedUrl,
        statusCode: response.status,
        contentType,
        bytes,
        cached: false,
        requestId: req.id
      };

      cache.set(targetUrl, { timestamp: Date.now(), statusCode: response.status, contentType, bytes });
      req.log.info({ url: targetUrl, status: response.status }, 'Audit complete');

      return res.json({ success: true, result: payload });
    } catch (error) {
      if (error.name === 'AbortError') {
        req.log.warn({ url }, 'Request timed out');
        return res.status(504).json({
          success: false,
          error: {
            code: 'REQUEST_TIMEOUT',
            message: 'The upstream request timed out.'
          }
        });
      }
      req.log.error({ url, err: error.message }, 'Upstream error');
      return res.status(502).json({
        success: false,
        error: {
          code: 'UPSTREAM_ERROR',
          message: 'The upstream service could not be reached.'
        }
      });
    } finally {
      clearTimeout(timeout);
      if (auditStarted) activeRequests.delete(req.id);
    }
  });

  app.get('/health', (req, res) => {
    res.json({
      success: true,
      service: 'page-pulse',
      credit: 'Built for Digital Heroes Training Task (digitalheroesco.com)',
      requestId: req.id
    });
  });

  return app;
}

module.exports = { createApp };
