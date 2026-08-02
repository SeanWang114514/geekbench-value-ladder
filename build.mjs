import { readFile, writeFile } from 'node:fs/promises';

const template = await readFile(new URL('./index.template.html', import.meta.url), 'utf8');
const raw = await readFile(new URL('./data.json', import.meta.url), 'utf8');
const safe = raw.replace(/</g, '\\u003c');
const html = template.replace('__DATA_JSON__', safe);
await writeFile(new URL('./index.html', import.meta.url), html, 'utf8');
console.log('index.html generated');
