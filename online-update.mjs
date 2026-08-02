import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  gpuKey,
  cpuKey,
  matchProducts,
  fetchBenchmarks,
  fetchZolPages,
  estimateSuning,
  estimateZolDetail,
} from './scrape.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(__dirname, 'cache');
const dataFile = path.join(__dirname, 'data.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function desktopOnly(list) {
  return list.filter((b) => !/(notebook|laptop|mobile|max-q)/i.test(b.name));
}

async function estimateForRows(kind, rows) {
  const targets = rows.filter((r) => r.price && !r.shopPrice);
  const estimates = new Map();
  let cursor = 0;
  const worker = async (workerIndex) => {
    while (cursor < targets.length) {
      const row = targets[cursor++];
      let est = null;
      if (row.zolId) {
        try {
          est = await estimateZolDetail(row.zolId, kind === 'gpu' ? 'vga' : 'cpu');
        } catch (err) {}
      }
      if (!est) {
        try {
          const keys = kind === 'gpu' ? gpuKey(row.name) : cpuKey(row.name);
          const query = (keys[0] || row.name).replace(/\s+/g, ' ');
          const tokenMatch = query.match(/(\d{3,5}[a-z0-9]*)/i);
          const token = tokenMatch ? tokenMatch[1].toLowerCase() : '';
          await sleep(600 + Math.floor(Math.random() * 900));
          est = await estimateSuning(query, token, kind, path.join(cacheDir, 'chrome-w' + workerIndex));
        } catch (err) {}
      }
      if (est && est.price) estimates.set(row.slug, est);
      console.log(`[estimate] ${kind} ${row.name}: ${est && est.price ? est.source + ' ' + est.price : 'failed'}`);
    }
  };
  const workerCount = Math.min(2, Math.max(1, targets.length));
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
  for (const row of rows) {
    const est = estimates.get(row.slug);
    if (est) row.estimate = { price: est.price, source: est.source, searchUrl: est.searchUrl };
  }
  return estimates.size;
}

async function main() {
  await mkdir(cacheDir, { recursive: true });
  const now = new Date().toISOString();

  const gpuBench = desktopOnly(await fetchBenchmarks('gpu'));
  const cpuBench = desktopOnly(await fetchBenchmarks('cpu'));
  const [gpuZol, cpuZol] = await Promise.all([
    fetchZolPages('vga', 'https://detail.zol.com.cn/vga/', path.join(cacheDir, 'zol_vga_1.html')),
    fetchZolPages('cpu', 'https://detail.zol.com.cn/cpu/', path.join(cacheDir, 'zol_cpu_1.html')),
  ]);

  const gpu = matchProducts(gpuBench, gpuZol, gpuKey);
  const cpu = matchProducts(cpuBench, cpuZol, cpuKey);

  const gpuEstimated = await estimateForRows('gpu', gpu);
  const cpuEstimated = await estimateForRows('cpu', cpu);

  const gpuPriced = gpu.filter((r) => r.price).length;
  const cpuPriced = cpu.filter((r) => r.price).length;
  const data = {
    fetchedAt: now,
    scoresUpdatedAt: now,
    pricesUpdatedAt: now,
    estimatesUpdatedAt: now,
    sources: {
      gpuBenchmark: 'https://cpuranklist.com/gpu-geekbench.php',
      cpuBenchmark: 'https://cpuranklist.com/cpu-geekbench.php',
      gpuPrice: 'https://detail.zol.com.cn/vga/',
      cpuPrice: 'https://detail.zol.com.cn/cpu/',
    },
    gpu,
    cpu,
  };
  await writeFile(dataFile, JSON.stringify(data, null, 2), 'utf8');
  console.log(`GPU: ${gpu.length} benchmarks, ${gpuPriced} with price, ${gpuEstimated} estimated`);
  console.log(`CPU: ${cpu.length} benchmarks, ${cpuPriced} with price, ${cpuEstimated} estimated`);
  console.log('data.json written');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
