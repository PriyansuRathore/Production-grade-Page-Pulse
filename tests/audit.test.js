const request = require('supertest');
const { createApp } = require('../src/app');

// Mock fetch before each test
beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
  delete global.fetch;
});

describe('Page Pulse API', () => {
  describe('Error Handling and Validation', () => {
    it('returns a validation error for an invalid URL', async () => {
      const app = createApp();
      const response = await request(app)
        .post('/api/audit')
        .send({ url: 'not-a-url' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it.each(['http://', 'http://localhost:3000', 'http://127.0.0.1/private'])('rejects unsafe URL %s', async (url) => {
      const app = createApp();
      const response = await request(app).post('/api/audit').send({ url });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('handles upstream timeouts gracefully', async () => {
      fetch.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject({ name: 'AbortError' }), 100)));

      const app = createApp({ timeoutMs: 50 });
      const response = await request(app)
        .post('/api/audit')
        .send({ url: 'https://example.com' });

      expect(response.status).toBe(504);
      expect(response.body.error.code).toBe('REQUEST_TIMEOUT');
    });

    it('handles other upstream fetch errors', async () => {
      fetch.mockRejectedValue(new Error('DNS lookup failed'));

      const app = createApp();
      const response = await request(app)
        .post('/api/audit')
        .send({ url: 'https://example.com' });

      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('UPSTREAM_ERROR');
    });
  });

  describe('Successful Audit', () => {
    it('audits a URL with a non-200 status code', async () => {
      fetch.mockResolvedValue({
        status: 404,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => 'Not Found',
      });

      const app = createApp();
      const response = await request(app)
        .post('/api/audit')
        .send({ url: 'https://example.com/not-found' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.result.statusCode).toBe(404);
    });

    it('audits a reachable URL with structured response data', async () => {
      fetch.mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        text: async () => '<html></html>',
      });

      const app = createApp();
      const response = await request(app)
        .post('/api/audit')
        .send({ url: 'https://example.com' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.result.url).toBe('https://example.com');
      expect(response.body.result.statusCode).toBe(200);
      expect(response.body.result.cached).toBe(false);
    });
  });

  describe('Concurrency and Rate Limiting', () => {
    it('enforces concurrency limits', async () => {
      let resolveFetch;
      fetch.mockImplementation(() => new Promise(resolve => (resolveFetch = resolve)));
      
      const app = createApp({ concurrencyLimit: 1 });
      
      // First request will hang
      request(app).post('/api/audit').send({ url: 'https://example.com/1' }).then();
      await new Promise(r => setTimeout(r, 50)); // let the first request start

      // Second request should be rejected
      const response = await request(app).post('/api/audit').send({ url: 'https://example.com/2' });
      
      expect(response.status).toBe(429);
      expect(response.body.error.code).toBe('CONCURRENCY_LIMITED');
      
      // Clean up hanging request
      resolveFetch({
        status: 200,
        headers: new Headers(),
        text: async () => '',
      });
    });

    it('rate limits repeated requests per client', async () => {
      fetch.mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html></html>',
      });

      const app = createApp({ rateLimitWindowMs: 60000, rateLimitMax: 1 });

      const first = await request(app)
        .post('/api/audit')
        .send({ url: 'https://example.com' });
      const second = await request(app)
        .post('/api/audit')
        .send({ url: 'https://example.com' });

      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
      expect(second.body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('Caching', () => {
    it('serves a valid cached response', async () => {
      fetch.mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html></html>',
      });

      const app = createApp({ cacheWindowMs: 10000 });
      await request(app).post('/api/audit').send({ url: 'https://example.com' });
      
      const response = await request(app).post('/api/audit').send({ url: 'https://example.com' });

      expect(response.status).toBe(200);
      expect(response.body.result.cached).toBe(true);
      expect(response.body.result.bytes).toBe(Buffer.byteLength('<html></html>'));
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after cache expires', async () => {
      fetch.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: async () => '',
      });

      const app = createApp({ cacheWindowMs: 50 });
      await request(app).post('/api/audit').send({ url: 'https://example.com' });
      
      await new Promise(r => setTimeout(r, 100)); // Wait for cache to expire
      
      const response = await request(app).post('/api/audit').send({ url: 'https://example.com' });

      expect(response.body.result.cached).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('/health endpoint', () => {
    it('returns a successful health check', async () => {
      const app = createApp();
      const response = await request(app).get('/health');
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.service).toBe('page-pulse');
    });

    it('includes the credit line in the health check', async () => {
      const app = createApp();
      const response = await request(app).get('/health');

      expect(response.body.credit).toContain('Digital Heroes');
    });
  });

  describe('/ landing page', () => {
    it('renders the required public credit', async () => {
      const app = createApp();
      const response = await request(app).get('/');

      expect(response.status).toBe(200);
      expect(response.type).toBe('text/html');
      expect(response.text).toContain('Built for Digital Heroes Training Task');
      expect(response.text).toContain('https://digitalheroesco.com');
    });

    it('does not return an error for a browser favicon request', async () => {
      const app = createApp();
      const response = await request(app).get('/favicon.ico');

      expect(response.status).toBe(204);
    });
  });
});
