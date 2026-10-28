/**
 * Headless check of the library's host example (mist.html): boots a WebGPU Chromium on
 * SwiftShader's Vulkan ICD (no GPU needed), waits for 90 frames, screenshots, and fails on
 * any page error. Uses Playwright's Chromium when present, else a local Chrome.
 *
 *   npm run dev -- --port 4178 --host 127.0.0.1   (in another shell)
 *   node tools/mist-smoke.mjs                      # writes dist/mist-smoke.png
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const PORT = Number(process.env.PORT ?? 4178);
const url = `http://127.0.0.1:${PORT}/mist.html`;

async function playwright() {
  const req = createRequire(import.meta.url);
  for (const candidate of ['playwright', '/opt/npm-tools/node_modules/playwright/index.mjs']) {
    try {
      const resolved = candidate.startsWith('/') ? candidate : req.resolve(candidate);
      const mod = await import(resolved.startsWith('/') ? new URL(`file://${resolved}`).href : resolved);
      return mod.chromium ?? mod.default?.chromium;
    } catch {
      // next
    }
  }
  return null;
}

const chromium = await playwright();
if (!chromium) {
  console.error('playwright not found; install it (npm i -D playwright && npx playwright install chromium) or run tools/cdp-smoke.mjs with a local Chrome');
  process.exit(2);
}

let server = null;
const reachable = await fetch(url).then((r) => r.ok).catch(() => false);
if (!reachable) {
  server = spawn('npx', ['vite', '--configLoader', 'runner', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('vite did not start')), 30000);
    server.stdout.on('data', (d) => { if (/localhost|127\.0\.0\.1/.test(String(d))) { clearTimeout(t); resolve(); } });
    server.on('exit', (c) => reject(new Error('vite exited ' + c)));
  });
}

// Playwright's headless shell has no WebGPU; the full Chromium build does, on SwiftShader Vulkan.
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers']
  .flatMap((d) => (existsSync(d) ? [d] : []))
  .flatMap((d) => {
    const { readdirSync } = require_('node:fs');
    return readdirSync(d).filter((n) => n.startsWith('chromium-')).map((n) => `${d}/${n}/chrome-linux64/chrome`);
  })
  .find((p) => existsSync(p));
function require_(m) { return createRequire(import.meta.url)(m); }

const browser = await chromium.launch({
  ...(exe ? { executablePath: exe } : { channel: 'chromium' }),
  headless: true,
  ignoreDefaultArgs: ['--disable-gpu'],
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mist && window.__mist.frames() > 40, null, { timeout: 240000 });
  const info = await page.evaluate(() => ({ frames: window.__mist.frames(), dispatches: window.__mist.mist.solver.dispatchesPerFrame, backend: window.__mist.renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl' }));
  mkdirSync('dist', { recursive: true });
  await page.screenshot({ path: 'dist/mist-smoke.png' });
  console.log('mist smoke:', JSON.stringify(info), 'errors:', errors.length ? errors : 'none');
  if (info.backend !== 'webgpu') throw new Error('expected the WebGPU backend');
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
  server?.kill('SIGTERM');
}
