import { writeFile, mkdtemp, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const profile = await mkdtemp(join(tmpdir(), 'fn-material-'));
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir='+profile, '--no-first-run', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--window-size=1280,800', 'about:blank'], {windowsHide:true, stdio:'ignore'});
process.on('exit', () => chrome.kill());
let endpoint;
for(let i=0;i<80;i++) {
  try {
    const port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim();
    endpoint = 'http://127.0.0.1:' + port;
    break;
  } catch { await new Promise(r=>setTimeout(r,250)); }
}
if (!endpoint) throw new Error('Test browser did not expose its debugging port');
for(let i=0;i<40;i++) {
  try { await fetch(endpoint+'/json/version'); break; } catch { await new Promise(r=>setTimeout(r,250)); }
}
const pages = await fetch(endpoint + '/json').then(r => r.json());
const page = pages.find(p => p.type === 'page');
if (!page) throw new Error('No browser page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const errors = [];
let sequence = 0;
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown' || (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')) errors.push(m.params);
};
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP timeout: ' + method)), 20000);
    pending.set(id, m => { clearTimeout(timeout); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const delay = ms => new Promise(r => setTimeout(r, ms));
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
};
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:4175/' });
  for (let i = 0; i < 30; i++) {
    if (await evaluate('Boolean(document.querySelector("[data-select=material-preset]"))')) break;
    await delay(500);
  }
  if (!await evaluate('Boolean(document.querySelector("[data-select=material-preset]"))')) {
    throw new Error('Application did not start on http://127.0.0.1:4175/');
  }
  for(let i=0;i<120;i++) {
    if(await evaluate('document.querySelector("[data-metric=state]")?.textContent === "LIVE"')) break;
    if(errors.length) throw new Error(JSON.stringify(errors));
    await delay(500);
  }
  if(!await evaluate('document.querySelector("[data-metric=state]")?.textContent === "LIVE"')) throw new Error('Renderer never became live: '+JSON.stringify(errors));
  await evaluate('document.querySelector("[data-action=pause]").click()');
  const result=await send('Runtime.evaluate',{expression:"import('/tools/ground-intersection-validation.ts').then(async m=>{window.__groundValidation=await m.validateGround();return {minimumSnowHeight:window.__groundValidation.minimumSnowHeight};})",awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  console.log('Ground regression:',JSON.stringify(result.result.value));
  for(const view of ['overworld','dungeon']) {
    const rendered=await send('Runtime.evaluate',{expression:`window.__groundValidation.render('${view}')`,awaitPromise:true});
    if(rendered.exceptionDetails) throw new Error(JSON.stringify(rendered.exceptionDetails));
    const shot=await send('Page.captureScreenshot',{format:'png'});
    await writeFile('ground-depression-'+view+'.png',Buffer.from(shot.data,'base64'));
  }
  const scrolled=await send('Runtime.evaluate',{expression:'window.__groundValidation.checkScroll()',awaitPromise:true});
  if(scrolled.exceptionDetails) throw new Error(JSON.stringify(scrolled.exceptionDetails));
  console.log('Ground latest-buffer and scroll checks passed; browser errors:',errors.length);
  await evaluate('window.__groundValidation.dispose()');
  if (errors.length) throw new Error(JSON.stringify(errors));
} finally { ws.close(); chrome.kill(); }
// Chrome can retain inherited process handles briefly after termination.
process.exit(0);


