import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(__dirname, 'cache');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fileExists(file) {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function download(url, file, headers = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, ...headers },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(file, buf);
      return buf;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        console.log(`retry ${attempt} for ${url} after ${err.message}`);
        await sleep(1500 * attempt * attempt);
      }
    }
  }
  throw lastErr;
}

const BROWSER_PATHS = [
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
].filter(Boolean);

async function findBrowser() {
  for (const p of BROWSER_PATHS) {
    try {
      await access(p, constants.R_OK);
      return p;
    } catch (err) {}
  }
  return null;
}

async function renderDom(url, profileDir) {
  const browser = await findBrowser();
  if (!browser) throw new Error('未找到 Chrome/Edge，无法抓取估价');
  await mkdir(profileDir, { recursive: true });
  const { stdout } = await execFileAsync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      `--user-data-dir=${profileDir}`,
      '--virtual-time-budget=12000',
      '--dump-dom',
      url,
    ],
    { timeout: 30000, maxBuffer: 50 * 1024 * 1024, windowsHide: true }
  );
  return stdout;
}

function parseSuningSearch(html, token, kind) {
  const items = [];
  const liRe = /<li\b[^>]*class="[^"]*\bdef product\b[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  for (const m of html.matchAll(liRe)) {
    const block = m[1];
    const titleM = block.match(/class="pro-title[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const priceM = block.match(/class="price-num"[^>]*>([\s\S]*?)<\/em>/);
    if (!titleM || !priceM) continue;
    const title = titleM[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    const price = Number(priceM[1].replace(/<[^>]+>/g, '').replace(/[¥￥\s,]/g, ''));
    if (!Number.isFinite(price) || price <= 0) continue;
    if (/广告|推广/.test(title)) continue;
    if (kind === 'gpu') {
      if (/工作站|台式机|主机|整机|一体机|笔记本|游戏本|服务器|组装机|内存|固态|硬盘|DDR|SSD|NVME|显卡坞|Ultra \d|i[3579]-|锐龙|Ryzen|酷睿|赛扬|奔腾|电脑(?!独立显卡)/i.test(title)) continue;
      if (!/\b(rtx|gtx|rx|arc|geforce|radeon|pro)\b/i.test(title)) continue;
      const gpuNums = title.match(/\b(?:rtx|gtx|rx)\s*(\d{3,5})\w*/gi) || [];
      if (gpuNums.some((n) => !n.replace(/\D/g, '').includes(token))) continue;
    }
    if (kind === 'cpu' && /工作站|台式机|主机|整机|一体机|笔记本|游戏本|服务器|电脑|组装机|内存|固态|硬盘|DDR|SSD|NVME|显卡|RTX|GTX|\bRX\b|Arc /i.test(title)) continue;
    if (token && !title.toLowerCase().includes(token)) continue;
    items.push({ title, price });
  }
  return items;
}

async function estimateSuning(query, token, kind, profileDir) {
  const url = 'https://m.suning.com/search/' + encodeURIComponent(query) + '/';
  const html = await renderDom(url, profileDir);
  const items = parseSuningSearch(html, token, kind);
  const prices = items.map((i) => i.price);
  if (!prices.length) return null;
  const counts = new Map();
  for (const p of prices) {
    const k = Math.round(p * 100) / 100;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let mode = null;
  let modeCount = 0;
  for (const [k, c] of counts) {
    if (c > modeCount) {
      mode = k;
      modeCount = c;
    }
  }
  const average = Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100;
  return {
    price: modeCount >= 2 ? mode : average,
    mode,
    modeCount,
    average,
    count: prices.length,
    samples: prices.slice(0, 12),
    source: 'suning',
    searchUrl: url,
  };
}

async function fetchText(url, headers = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, ...headers },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        console.log(`retry ${attempt} for ${url} after ${err.message}`);
        await sleep(1500 * attempt * attempt);
      }
    }
  }
  throw lastErr;
}

function parseJdItems(html) {
  const items = [];
  const liRe = /<li\b([^>]*data-sku="(\d+)"[^>]*)>([\s\S]*?)<\/li>/g;
  for (const m of html.matchAll(liRe)) {
    if (!/\bgl-item\b/.test(m[1])) continue;
    const li = m[3];
    if (/gl-item-promo|p-promo|data-promo|promo-tag/i.test(li)) continue;
    const price = extractJdPrice(li);
    if (!price) continue;
    const nameM = li.match(/class="p-name"[^>]*>[\s\S]*?<em>([\s\S]*?)<\/em>/);
    const name = nameM ? nameM[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() : '';
    if (!name || /广告|推广/.test(name)) continue;
    items.push({ sku: m[2], name, price });
  }
  if (items.length) return items;
  const chunks = html.split(/(?=<div\b[^>]*class="[^"]*\bsearch_prolist_item\b[^"]*")/);
  for (const chunk of chunks) {
    const skuM = chunk.match(/data-sku="(\d+)"/);
    if (!skuM) continue;
    const price = extractJdPrice(chunk);
    if (!price) continue;
    const titleM = chunk.match(/class="[^"]*\bsearch_prolist_title\b[^"]*"[^>]*>([\s\S]*?)<\//);
    const name = titleM ? titleM[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() : '';
    if (!name || /广告|推广/.test(name)) continue;
    items.push({ sku: skuM[1], name, price });
  }
  return items;
}

function extractJdPrice(html) {
  const m = html.match(
    /(?:search_prolist_price|p-price|pro-price)[^>]*>\s*(?:<[^>]+>\s*)*(?:[¥￥])?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/
  );
  if (!m) return null;
  const price = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : null;
}

async function estimateJd(query, cookie) {
  const enc = encodeURIComponent(query);
  const urls = [
    {
      url: `https://so.m.jd.com/ware/search.action?keyword=${enc}&searchType=1&page=1`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      },
    },
    {
      url: `https://search.jd.com/Search?keyword=${enc}&enc=utf-8`,
      headers: { 'User-Agent': UA },
    },
  ];
  let lastErr = null;
  for (const item of urls) {
    try {
      const html = await fetchText(item.url, {
        ...item.headers,
        Referer: 'https://www.jd.com/',
        ...(cookie ? { Cookie: cookie } : {}),
      });
      if (/passport\.jd\.com|京东登录|京东验证|安全验证|欢迎登录/.test(html)) {
        lastErr = new Error('京东登录失效或需要验证');
        continue;
      }
      const items = parseJdItems(html);
      const prices = items.map((i) => i.price);
      if (!prices.length) continue;
      const counts = new Map();
      for (const p of prices) {
        const k = Math.round(p * 100) / 100;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      let mode = null;
      let modeCount = 0;
      for (const [k, c] of counts) {
        if (c > modeCount) {
          mode = k;
          modeCount = c;
        }
      }
      const average = Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100;
      return {
        price: modeCount >= 2 ? mode : average,
        mode,
        modeCount,
        average,
        count: prices.length,
        samples: prices.slice(0, 12),
        source: 'jd',
        searchUrl: item.url,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr && /登录|验证/.test(lastErr.message)) throw lastErr;
  return null;
}

async function fetchJdQr() {
  const res = await fetch('https://qr.m.jd.com/show?appid=133&size=300&t=' + Date.now(), {
    headers: { 'User-Agent': UA, Referer: 'https://passport.jd.com/new/login.aspx' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookie = setCookies
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ');
  return { pngBase64: buf.toString('base64'), cookie };
}

async function checkJdQr(cookie, token) {
  const cb = 'jQuery' + Math.floor(Math.random() * 1e6);
  const url =
    `https://qr.m.jd.com/check?appid=133&callback=${cb}` +
    `&token=${encodeURIComponent(token)}&_=${Date.now()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://passport.jd.com/new/login.aspx', Cookie: cookie },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { code: -1, msg: '响应异常' };
  try {
    return JSON.parse(m[0]);
  } catch (err) {
    return { code: -1, msg: '响应异常' };
  }
}

async function resolveJdLoginUrl(cookie, ticket) {
  const qs = new URLSearchParams({
    t: ticket,
    pageSource: 'login2025',
    pageLocation: '',
    ReturnUrl: '',
    h5st: '',
    _stk: '',
    firstShowAccountLoginPage: '',
    ssoDomains: '',
  });
  const res = await fetch('https://passport.jd.com/uc/qrCodeTicketValidation?' + qs.toString(), {
    headers: {
      'User-Agent': UA,
      Referer: 'https://passport.jd.com/new/login.aspx',
      Cookie: cookie,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const data = JSON.parse(text);
  if (data.returnCode !== 0 || !data.url) return null;
  return data.url;
}

async function finishJdQrLogin(cookie, ticketOrUrl) {
  let u = ticketOrUrl;
  if (u && !/^https?:\/\//i.test(u)) {
    u = await resolveJdLoginUrl(cookie, u);
    if (!u) return null;
  }
  const allCookies = [];
  let currentCookie = cookie;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(u, {
      headers: { 'User-Agent': UA, Referer: 'https://passport.jd.com/new/login.aspx', Cookie: currentCookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    if (res.headers.getSetCookie) {
      const set = res.headers.getSetCookie();
      allCookies.push(...set);
      currentCookie = mergeCookies(currentCookie, set);
    }
    const loc = res.headers.get('location');
    if (!loc) break;
    u = new URL(loc, u).toString();
  }
  const map = {};
  for (const c of allCookies) {
    const eq = c.indexOf('=');
    if (eq <= 0) continue;
    const name = c.slice(0, eq);
    if (name !== 'pt_key' && name !== 'pt_pin') continue;
    const semi = c.indexOf(';');
    map[name] = semi === -1 ? c.slice(eq + 1) : c.slice(eq + 1, semi);
  }
  if (!map['pt_key'] || !map['pt_pin']) return null;
  return `pt_key=${map['pt_key']}; pt_pin=${map['pt_pin']}`;
}

function mergeCookies(base, setCookies) {
  const map = new Map();
  for (const part of base.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  for (const c of setCookies) {
    const first = c.split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    map.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function readFileIfExists(file) {
  if (await fileExists(file)) return readFile(file);
  return null;
}

function parseCpRankList(html) {
  const dataMatch = html.match(
    /<script id="product-data" type="application\/json">\s*(\[[\s\S]*?\])\s*<\/script>/
  );
  const remainingMatch = html.match(
    /<script id="product-data-remaining" type="application\/json">\s*(\[[\s\S]*?\])\s*<\/script>/
  );
  if (!dataMatch) throw new Error('product-data not found');
  const list = JSON.parse(dataMatch[1]);
  if (remainingMatch) list.push(...JSON.parse(remainingMatch[1]));
  return list;
}

function parseZol(html) {
  const items = [];
  const liRe = /<li\b[^>]*data-follow-id="p(\d+)"[^>]*>([\s\S]*?)<\/li>/g;
  for (const m of html.matchAll(liRe)) {
    const li = m[2];
    const h3 = li.match(/<h3>\s*<a[^>]*>([\s\S]*?)<\/a>/);
    if (!h3) continue;
    const name = h3[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (!name) continue;
    const refMatch = li.match(/<b class="price-type">([0-9]+)<\/b>/);
    const refPrice = refMatch ? Number(refMatch[1]) : null;
    const shopPrices = [];
    const priceRe = /(?:￥|¥|&yen;)\s*([0-9]+(?:\.[0-9]+)?)(万)?/gi;
    for (const pm of li.matchAll(priceRe)) {
      const val = Number(pm[1]) * (pm[2] ? 10000 : 1);
      shopPrices.push(val);
    }
    const shopPrice = shopPrices.length ? Math.min(...shopPrices) : null;
    items.push({
      id: m[1],
      name,
      refPrice,
      shopPrice,
      price: shopPrice ?? refPrice,
    });
  }
  return items;
}

function normText(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function gpuKey(name) {
  const s = normText(name);
  const keys = new Set();
  const re = /\b(rtx|gtx|rx|arc|titan)\s*([ab]?\d{3,5}[a-z0-9]*)(?:\s*(?:super|ti|xtx|xt|gre|gme|le|d|s|m|oc|ultra))?/g;
  for (const m of s.matchAll(re)) {
    keys.add(m[0].replace(/\s+/g, ' '));
  }
  return [...keys];
}

function cpuKey(name) {
  const s = normText(name);
  const keys = new Set();
  const coreRe = /(?:core\s*ultra\s*\d+\s*)?(i[3579])\s*-?\s*(\d{4,5}[a-z0-9]*)/g;
  for (const m of s.matchAll(coreRe)) {
    keys.add(`${m[1]} ${m[2]}`);
  }
  const ryzenRe = /ryzen(?:\s*(?:ai|pro|threadripper))?\s*(\d)?\s*(\d{4}[a-z0-9]*)/g;
  for (const m of s.matchAll(ryzenRe)) {
    keys.add(`ryzen${m[1] ? ' ' + m[1] : ''} ${m[2]}`);
  }
  for (const re of [/\b(xeon)\s*([a-z0-9-]+)/g, /\b(athlon)\s*([a-z0-9-]+)/g, /\b(epyc)\s*([a-z0-9-]+)/g]) {
    for (const m of s.matchAll(re)) {
      keys.add(`${m[1]} ${m[2]}`);
    }
  }
  return [...keys];
}

function matchProducts(benchmarks, zolItems, keyFn) {
  const byKey = new Map();
  for (const item of zolItems) {
    for (const key of keyFn(item.name)) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(item);
    }
  }

  return benchmarks.map((b) => {
    const keys = keyFn(b.name);
    let best = null;
    for (const key of keys) {
      const items = byKey.get(key);
      if (!items) continue;
      for (const item of items) {
        if (!item.price) continue;
        if (!best || item.price < best.price) best = item;
      }
    }
    return {
      slug: b.slug,
      name: b.name,
      score: b.score,
      ...(best
        ? {
            price: best.price,
            refPrice: best.refPrice,
            shopPrice: best.shopPrice,
            priceFrom: best.name,
          }
        : { price: null }),
    };
  });
}

async function fetchZolPages(kind, baseUrl, htmlFile) {
  let html;
  if (await fileExists(htmlFile)) {
    html = new TextDecoder('gbk').decode(await readFile(htmlFile));
  } else {
    const buf = await download(baseUrl, htmlFile, { Referer: 'https://detail.zol.com.cn/' });
    html = new TextDecoder('gbk').decode(buf);
  }
  const pageMatch = html.match(/<span class="small-page-active"><b>\d+<\/b>\/(\d+)<\/span>/);
  if (!pageMatch) throw new Error(`page count not found for ${kind}`);
  const total = Number(pageMatch[1]);
  const all = parseZol(html);

  for (let page = 2; page <= total; page++) {
    const file = path.join(cacheDir, `zol_${kind}_${page}.html`);
    const url = `https://detail.zol.com.cn/${kind}/${page}.html`;
    let buf;
    if (await fileExists(file)) {
      buf = await readFile(file);
    } else {
      buf = await download(url, file, { Referer: 'https://detail.zol.com.cn/' });
      await sleep(700);
    }
    all.push(...parseZol(new TextDecoder('gbk').decode(buf)));
    if (page % 10 === 0) console.log(`${kind}: ${page}/${total} pages, ${all.length} items`);
  }
  console.log(`${kind}: ${total} pages, ${all.length} items`);
  return all;
}

async function fetchBenchmarks(kind) {
  const file = path.join(cacheDir, `${kind}_geekbench.html`);
  const url =
    kind === 'gpu' ? 'https://cpuranklist.com/gpu-geekbench.php' : 'https://cpuranklist.com/cpu-geekbench.php';
  let html;
  if (await fileExists(file)) {
    html = await readFile(file, 'utf8');
  } else {
    html = (await download(url, file)).toString('utf8');
  }
  return parseCpRankList(html);
}

async function main() {
  await mkdir(cacheDir, { recursive: true });
  const moveIfNeeded = async (src, dst) => {
    if ((await fileExists(src)) && !(await fileExists(dst))) {
      await writeFile(dst, await readFile(src));
      console.log(`moved ${src} -> ${dst}`);
    }
  };
  await moveIfNeeded(path.join(__dirname, 'gpu_geekbench.html'), path.join(cacheDir, 'gpu_geekbench.html'));
  await moveIfNeeded(path.join(__dirname, 'cpu_geekbench.html'), path.join(cacheDir, 'cpu_geekbench.html'));
  await moveIfNeeded(path.join(__dirname, 'zol_vga.html'), path.join(cacheDir, 'zol_vga_1.html'));
  await moveIfNeeded(path.join(__dirname, 'zol_cpu.html'), path.join(cacheDir, 'zol_cpu_1.html'));

  const gpuBench = await fetchBenchmarks('gpu');
  const cpuBench = await fetchBenchmarks('cpu');
  const desktopGpuBench = gpuBench.filter((b) => !/(notebook|mobile|laptop|max-q)/i.test(b.name));
  const desktopCpuBench = cpuBench.filter((b) => !/(notebook|laptop|mobile)/i.test(b.name));
  const gpuZol = await fetchZolPages('vga', 'https://detail.zol.com.cn/vga/', path.join(cacheDir, 'zol_vga_1.html'));
  const cpuZol = await fetchZolPages('cpu', 'https://detail.zol.com.cn/cpu/', path.join(cacheDir, 'zol_cpu_1.html'));

  const gpu = matchProducts(desktopGpuBench, gpuZol, gpuKey);
  const cpu = matchProducts(desktopCpuBench, cpuZol, cpuKey);

  const gpuPriced = gpu.filter((x) => x.price).length;
  const cpuPriced = cpu.filter((x) => x.price).length;
  console.log(`GPU: ${gpu.length} benchmarks, ${gpuPriced} with price`);
  console.log(`CPU: ${cpu.length} benchmarks, ${cpuPriced} with price`);

  const data = {
    fetchedAt: new Date().toISOString(),
    sources: {
      gpuBenchmark: 'https://cpuranklist.com/gpu-geekbench.php',
      cpuBenchmark: 'https://cpuranklist.com/cpu-geekbench.php',
      gpuPrice: 'https://detail.zol.com.cn/vga/',
      cpuPrice: 'https://detail.zol.com.cn/cpu/',
    },
    gpu,
    cpu,
  };
  await writeFile(path.join(__dirname, 'data.json'), JSON.stringify(data, null, 2), 'utf8');
  console.log('data.json written');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export {
  gpuKey,
  cpuKey,
  matchProducts,
  parseZol,
  normText,
  fetchBenchmarks,
  fetchZolPages,
  estimateSuning,
  estimateJd,
  fetchJdQr,
  checkJdQr,
  finishJdQrLogin,
};
