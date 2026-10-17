import { createServer } from 'node:http';

const allowedOptions = new Set(['url', 'urls', 'search', 'query', 'sites', 'from', 'to', 'limit', 'read', 'refresh', 'interactive', 'timeoutMs']);
const feedOptions = new Set(['sites', 'feed_ids', 'keywords', 'from', 'to', 'limit', 'timeoutMs']);
async function readBody(request, allowed = allowedOptions) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw Object.assign(new Error('Use application/json'), { statusCode: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw Object.assign(new Error('JSON body exceeds 64 KiB'), { statusCode: 413 });
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Supply a JSON object');
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unsupported request field: ${key}`);
  for (const key of ['read', 'refresh', 'interactive']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  return value;
}
function searchInput(body) { return body.search || { query: body.query, sites: body.sites, from: body.from, to: body.to, limit: body.limit }; }

export async function startReaderServer({ engine, port = 8787, log = () => {} }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  let stopping = false;
  const server = createServer(async (request, response) => {
    const send = (code, data) => {
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify(data));
    };
    try {
      const host = new URL('http://' + request.headers.host).hostname;
      if (!['localhost', '127.0.0.1'].includes(host)) return send(403, { status: 'error', error: 'Localhost Host header required' });
      if (request.headers.origin && !['http://localhost:' + server.address().port, 'http://127.0.0.1:' + server.address().port].includes(request.headers.origin)) return send(403, { status: 'error', error: 'Cross-origin requests are not enabled' });
      if (stopping) return send(503, { status: 'error', error: 'Server is stopping' });
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && path === '/health') return send(200, await engine.health());
      if (request.method === 'GET' && path === '/jobs') return send(200, { jobs: await engine.listJobs() });
      const match = /^\/jobs\/([a-zA-Z0-9_-]+)(\/resume)?$/.exec(path);
      if (request.method === 'GET' && match && !match[2]) return send(200, await engine.getJob(match[1]));
      if (request.method === 'POST') {
        const body = await readBody(request, path === '/rss-discover' ? feedOptions : allowedOptions);
        if (path === '/rss-discover') return send(200, await engine.discoverFeedArticles(body));
        const options = { refresh: body.refresh, interactive: body.interactive, timeoutMs: body.timeoutMs };
        if (match?.[2]) {
          const job = await engine.getJob(match[1]);
          engine.runJob(job.id).catch(error => log(error.message));
          return send(202, { job_id: job.id, status_url: '/jobs/' + job.id });
        }
        if (path === '/read') return send(200, await engine.readArticle({ ...options, url: body.url }));
        if (path === '/search') {
          const job = await engine.searchArticles(searchInput(body), options);
          return send(200, { ...job.discovery, job_id: job.id, state: job.state, error: job.error || job.discovery?.error || null });
        }
        if (path === '/search-read') return send(200, await engine.batch({ ...options, search: searchInput(body), read: true }));
        if (path === '/jobs') {
          const { job, completion } = await engine.enqueue({ ...options, urls: body.urls,
            search: body.search || body.query ? searchInput(body) : undefined, read: body.read ?? true });
          completion.catch(error => log(error.message));
          return send(202, { job_id: job.id, state: job.state, status_url: '/jobs/' + job.id });
        }
      }
      return send(404, { status: 'error', error: 'Route not found' });
    } catch (error) { send(error.statusCode || (error.code === 'ENOENT' ? 404 : 400), { status: 'error', error: error.message }); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return { url: `http://127.0.0.1:${server.address().port}`, server, close: async () => {
    if (stopping) return;
    stopping = true;
    await engine.tail;
    server.closeIdleConnections();
    await new Promise(done => server.close(done));
  } };
}
