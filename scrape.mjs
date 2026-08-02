import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

export { gpuKey, cpuKey, matchProducts, parseZol, normText, fetchBenchmarks, fetchZolPages };
