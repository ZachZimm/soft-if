import { copyFile, mkdir } from 'node:fs/promises';
await mkdir(new URL('../dist/src/debugger/', import.meta.url), { recursive: true });
try { await copyFile(new URL('../src/debugger/page.html', import.meta.url), new URL('../dist/src/debugger/page.html', import.meta.url)); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
