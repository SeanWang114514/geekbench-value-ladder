import { createServer } from 'node:http';
import { readFile, writeFile, access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gpuKey,
  cpuKey,
  matchProducts,
  fetchBenchmarks,
  fetchZolPages,
  estimateSuning,
  estimateJd,
  openJdLogin,
  checkJdProfile,
  estimateJdByProfile,
} from './scrape.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8765);
const cacheDir = path.join(__dirname, 'cache');
const dataFile = path.join(__dirname, 'data.json');

const SOURCES = {
  gpuBenchmark: 'https://cpuranklist.com/gpu-geekbench.php',
  cpuBenchmark: 'https://cpuranklist.com/cpu-geekbench.php',
  gpuPrice: 'https://detail.zol.com.cn/vga/',
  cpuPrice: 'https://detail.zol.com.cn/cpu/',
};

let memory = null;
let lock = Promise.resolve();

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

const cookieFile = path.join(cacheDir, 'jd-cookie.json');
const jdProfileDir = path.join(cacheDir, 'jd-profile');
const jdLoginFile = path.join(cacheDir, 'jd-login.json');

async function readJdCookie() {
  if (!(await fileExists(cookieFile))) return null;
  try {
    return (await readJson(cookieFile)).cookie || null;
  } catch (err) {
    return null;
  }
}

function dayStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

function desktopOnly(list) {
  return list.filter((b) => !/(notebook|laptop|mobile|max-q)/i.test(b.name));
}

async function ensureMemory() {
  if (memory) return memory;
  memory = await readJson(dataFile);
  return memory;
}

async function loadBenchmarks(kind, forceRefresh) {
  const cacheFile = path.join(cacheDir, `bench-${kind}.json`);
  if (!forceRefresh && (await fileExists(cacheFile))) {
    const cached = await readJson(cacheFile);
    return { list: cached.list, fetchedAt: cached.fetchedAt };
  }
  if (!forceRefresh) {
    const base = await ensureMemory();
    const list = base[kind].map(({ slug, name, score }) => ({ slug, name, score }));
    const fetchedAt = base.scoresUpdatedAt || base.fetchedAt;
    await writeJson(cacheFile, { fetchedAt, list });
    return { list, fetchedAt };
  }
  const list = await fetchBenchmarks(kind);
  const fetchedAt = new Date().toISOString();
  await writeJson(cacheFile, { fetchedAt, list });
  return { list, fetchedAt };
}

async function loadZolItems(kind) {
  const cacheFile = path.join(cacheDir, `prices-${kind}-${dayStamp()}.json`);
  if (await fileExists(cacheFile)) {
    const cached = await readJson(cacheFile);
    return { items: cached.items, fetchedAt: cached.fetchedAt };
  }
  const base = kind === 'gpu' ? 'vga' : 'cpu';
  const items = await fetchZolPages(
    base,
    `https://detail.zol.com.cn/${base}/`,
    path.join(cacheDir, `zol_${base}_1.html`)
  );
  const fetchedAt = new Date().toISOString();
  await writeJson(cacheFile, { fetchedAt, items });
  return { items, fetchedAt };
}

async function priceEstimatesFor(kind) {
  const cacheFile = path.join(cacheDir, `estimate-${kind}-${dayStamp()}.json`);
  if (await fileExists(cacheFile)) {
    return readJson(cacheFile);
  }
  const base = await ensureMemory();
  const rows = base[kind].filter((r) => r.price && !r.shopPrice);
  const estimates = {};
  const cookie = await readJdCookie();
  const useProfile = await fileExists(jdLoginFile);
  let cursor = 0;
  let browserError = false;
  let jdError = null;
  const worker = async (workerIndex) => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        const keys = kind === 'gpu' ? gpuKey(row.name) : cpuKey(row.name);
        const query = (keys[0] || row.name).replace(/\s+/g, ' ');
        const tokenMatch = query.match(/(\d{3,5}[a-z0-9]*)/i);
        const token = tokenMatch ? tokenMatch[1].toLowerCase() : '';
        let est = null;
        if (useProfile) {
          try {
            est = await estimateJdByProfile(query, jdProfileDir);
          } catch (err) {
            jdError = err.message;
          }
        }
        if (!est && cookie) {
          try {
            est = await estimateJd(query, cookie);
          } catch (err) {
            jdError = err.message;
          }
        }
        if (!est) {
          try {
            est = await estimateSuning(query, token, kind, path.join(cacheDir, 'chrome-w' + workerIndex));
          } catch (err) {
            if (/Chrome|Edge/.test(err.message)) browserError = true;
          }
        }
        estimates[row.slug] = est ? { name: row.name, ...est } : { name: row.name, error: 'no result' };
      } catch (err) {
        estimates[row.slug] = { name: row.name, error: err.message };
      }
    }
  };
  const workerCount = Math.min(6, Math.max(1, rows.length));
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
  const payload = {
    kind,
    updatedAt: new Date().toISOString(),
    total: rows.length,
    estimated: Object.values(estimates).filter((e) => e.price).length,
    estimates,
  };
  if (payload.estimated === 0 && payload.total > 0) {
    if (browserError) {
      payload.notice = '未找到 Chrome/Edge，无法抓取估价，仍显示参考价';
    } else if ((useProfile || cookie) && jdError) {
      payload.notice = '京东登录可能已失效，苏宁也未匹配到，仍显示参考价';
    } else if (useProfile || cookie) {
      payload.notice = '京东与苏宁均未匹配到价格，仍显示参考价';
    } else {
      payload.notice = '未配置京东登录，苏宁也未匹配到，仍显示参考价';
    }
  }
  await writeJson(cacheFile, payload);
  console.log(`[estimate] ${kind}: ${payload.estimated}/${payload.total} estimated`);
  return payload;
}

async function buildData({ refreshScores = false } = {}) {
  const gpuBench = await loadBenchmarks('gpu', refreshScores);
  const cpuBench = await loadBenchmarks('cpu', refreshScores);
  const [gpuPrices, cpuPrices] = await Promise.all([loadZolItems('gpu'), loadZolItems('cpu')]);

  const gpu = matchProducts(desktopOnly(gpuBench.list), gpuPrices.items, gpuKey);
  const cpu = matchProducts(desktopOnly(cpuBench.list), cpuPrices.items, cpuKey);

  const now = new Date().toISOString();
  const data = {
    fetchedAt: now,
    scoresUpdatedAt: refreshScores ? now : gpuBench.fetchedAt,
    pricesUpdatedAt: [gpuPrices.fetchedAt, cpuPrices.fetchedAt].sort().at(-1),
    sources: SOURCES,
    gpu,
    cpu,
  };
  memory = data;
  await writeJson(dataFile, data);
  console.log(
    `[${now}] data ready: gpu ${gpu.length} (${gpu.filter((r) => r.price).length} priced), cpu ${cpu.length} (${cpu.filter((r) => r.price).length} priced)`
  );
  return data;
}

function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

function sendJson(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function sendError(res, err) {
  console.error(err);
  res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`服务器错误: ${err.message}`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === '/api/data' && req.method === 'GET') {
      const data = await withLock(() => buildData());
      sendJson(res, data);
      return;
    }
    if (url.pathname === '/api/refresh-benchmarks' && req.method === 'POST') {
      const data = await withLock(() => buildData({ refreshScores: true }));
      sendJson(res, data);
      return;
    }
    if (url.pathname === '/api/estimate-prices' && req.method === 'GET') {
      const kind = url.searchParams.get('kind') === 'cpu' ? 'cpu' : 'gpu';
      const payload = await withLock(() => priceEstimatesFor(kind));
      sendJson(res, payload);
      return;
    }
    if (url.pathname === '/api/jd-cookie' && req.method === 'GET') {
      sendJson(res, { hasCookie: !!(await readJdCookie()) });
      return;
    }
    if (url.pathname === '/api/jd-cookie' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const cookie = String(body.cookie || '').trim();
      if (!cookie) throw new Error('Cookie 为空');
      await writeJson(cookieFile, { cookie, savedAt: new Date().toISOString() });
      for (const k of ['gpu', 'cpu']) {
        await rm(path.join(cacheDir, `estimate-${k}-${dayStamp()}.json`), { force: true });
      }
      sendJson(res, { ok: true });
      return;
    }
    if (url.pathname === '/api/jd-cookie' && req.method === 'DELETE') {
      await rm(cookieFile, { force: true });
      sendJson(res, { ok: true });
      return;
    }
    if (url.pathname === '/api/jd-login' && req.method === 'POST') {
      await openJdLogin(jdProfileDir);
      sendJson(res, { ok: true });
      return;
    }
    if (url.pathname === '/api/jd-login-status' && req.method === 'GET') {
      sendJson(res, { loggedIn: await fileExists(jdLoginFile) });
      return;
    }
    if (url.pathname === '/api/jd-login-confirm' && req.method === 'POST') {
      const ok = await checkJdProfile(jdProfileDir);
      if (!ok) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '未检测到登录，请扫码后关闭京东窗口再试' }));
        return;
      }
      await writeJson(jdLoginFile, { loggedIn: true, checkedAt: new Date().toISOString() });
      for (const k of ['gpu', 'cpu']) {
        await rm(path.join(cacheDir, `estimate-${k}-${dayStamp()}.json`), { force: true });
      }
      sendJson(res, { ok: true });
      return;
    }
    if (url.pathname === '/api/jd-login' && req.method === 'DELETE') {
      await rm(jdLoginFile, { force: true });
      sendJson(res, { ok: true });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    sendError(res, err);
  }
});

await mkdir(cacheDir, { recursive: true });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`GPU/CPU 性价比天梯图服务已启动: http://127.0.0.1:${PORT}`);
  console.log('价格每日自动更新；跑分可在页面右上角设置中手动重新抓取');
});
