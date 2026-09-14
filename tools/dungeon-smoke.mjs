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
  for(let i=0;i<240;i++) {
    if(await evaluate('document.querySelector("[data-metric=state]")?.textContent === "LIVE"')) break;
    if(errors.length) throw new Error(JSON.stringify(errors));
    if(i%40===0) console.log('Renderer startup:',await evaluate('document.querySelector("[data-metric=state]")?.textContent')); 
    await delay(500);
  }
  if(!await evaluate('document.querySelector("[data-metric=state]")?.textContent === "LIVE"')) throw new Error('Renderer never became live: '+JSON.stringify(errors));
  if (process.env.SAND_NUMERIC_TEST === '1') {
    const result = await send('Runtime.evaluate', {expression:"import('/tools/sand-validation.ts').then(m => m.validateSand())",awaitPromise:true,returnByValue:true});
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    console.log('Sand GPU numeric checks:', JSON.stringify(result.result.value));
  }
  if (process.env.RESPONSE_NUMERIC_TEST === '1') {
    const result = await send('Runtime.evaluate', {expression:"import('/tools/response-validation.ts').then(m => m.validateResponses())",awaitPromise:true,returnByValue:true});
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    console.log('Snow/Grass GPU numeric checks:', JSON.stringify(result.result.value));
  }
  const dungeonTest=await send('Runtime.evaluate',{expression:"import('/tools/dungeon-validation.ts').then(m=>m.validateDungeon())",awaitPromise:true,returnByValue:true});
  if(dungeonTest.exceptionDetails)throw new Error(JSON.stringify(dungeonTest.exceptionDetails));
  console.log('Dungeon regression:',JSON.stringify(dungeonTest.result.value));
  if(process.env.ENCOUNTER_TEST === '1') {
    await delay(1800);
    await evaluate('document.querySelector("[data-player-retry]").click()');
    await delay(1750);
    if(await evaluate('window.__encounter().combat.phase')!=='warning') throw new Error('Live sentinel did not telegraph');
    const warningShot=await send('Page.captureScreenshot',{format:'png'});
    await writeFile('sentinel-warning.png',Buffer.from(warningShot.data,'base64'));
    const start=await evaluate('window.__encounter().player');
    await send('Input.dispatchKeyEvent',{type:'keyDown',code:'ShiftLeft',key:'Shift'});
    await send('Input.dispatchKeyEvent',{type:'keyUp',code:'ShiftLeft',key:'Shift'});
    await delay(350);
    const dodge=await evaluate('window.__encounter()');
    if(dodge.player[1]-start[1]<1 || dodge.combat.cooldown<=0) throw new Error('Shift did not move player and start cooldown');
    await send('Input.dispatchKeyEvent',{type:'keyDown',code:'KeyW',key:'w'});
    await delay(875);
    await send('Input.dispatchKeyEvent',{type:'keyUp',code:'KeyW',key:'w'});
    console.log('Live telegraph and Shift dodge passed');
    for(const camera of ['overworld','dungeon']) {
      await evaluate(`(() => {const s=document.querySelector('[data-encounter="camera"]');s.value='${camera}';s.dispatchEvent(new Event('change'));})()`);
      await delay(800);
      for(const power of ['modest','powerful']) {
        await evaluate('document.querySelector("[data-player-retry]").click()');
        await evaluate(`(() => {const s=document.querySelector('[data-encounter="power"]');s.value='${power}';s.dispatchEvent(new Event('change'));document.querySelector('[data-encounter="cast"]').click();})()`);
        await delay(180);
        const state=await evaluate('window.__encounter()');
        if(!state.enabled || state.responsePasses<4 || state.activeSpells<1 || (power==='powerful' && state.treeBend<=0)) throw new Error('Shared attack failed: '+JSON.stringify({state,errors}));
        if(state.radii[0] !== (power==='powerful'?5.2:2.5)) throw new Error('Attack strength mismatch');
        const shot=await send('Page.captureScreenshot',{format:'png'});
        await writeFile('encounter-'+camera+'-'+power+'.png',Buffer.from(shot.data,'base64'));
        console.log('encounter',camera,power,JSON.stringify(state));
        await delay(2600);
      }
    }
    await evaluate('document.querySelector("[data-action=pause]").click()');
    const before=await evaluate('window.__encounter().activeSpells');
    await evaluate('document.querySelector("[data-encounter=cast]").click()');
    if(await evaluate('window.__encounter().activeSpells')!==before) throw new Error('Paused cast was accepted');
    await evaluate('document.querySelector("[data-action=pause]").click()');
    await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:620,y:400,deltaX:0,deltaY:1000});
    await delay(500);
    const zoom=await evaluate('window.__encounter().zoom');
    if(zoom<=1 || zoom>1.65) throw new Error('Camera zoom failed');
    await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:620,y:400,deltaX:0,deltaY:-2500});
    await delay(800);
    if(await evaluate('window.__encounter().zoom')!==0.65) throw new Error('Close camera clamp failed');
    const closeShot=await send('Page.captureScreenshot',{format:'png'});
    await writeFile('encounter-dungeon-close.png',Buffer.from(closeShot.data,'base64'));
    await evaluate('document.querySelector("[data-action=reset]").click()');
    await delay(1000);
    const reset=await evaluate('window.__encounter()');
    if(!reset.enabled || reset.activeSpells!==0 || reset.treeBend!==0 || reset.responsePasses<4) throw new Error('Encounter reset failed');
    await evaluate('document.querySelector("[data-player-retry]").click()');
    for(let i=0;i<100;i++) {
      if(await evaluate('window.__encounter().combat.defeated')) break;
      await delay(300);
    }
    const defeated=await evaluate('window.__encounter()');
    if(!defeated.combat.defeated || defeated.combat.health!==0 || defeated.combat.hits!==4) throw new Error('Live four-hit defeat failed: '+JSON.stringify(defeated));
    const defeatShot=await send('Page.captureScreenshot',{format:'png'});
    await writeFile('player-defeated.png',Buffer.from(defeatShot.data,'base64'));
    await send('Input.dispatchKeyEvent',{type:'keyDown',code:'KeyW',key:'w'});
    await send('Input.dispatchKeyEvent',{type:'keyDown',code:'ShiftLeft',key:'Shift'});
    await send('Input.dispatchKeyEvent',{type:'keyDown',code:'Space',key:' '});
    await delay(400);
    for(const [code,key] of [['KeyW','w'],['ShiftLeft','Shift'],['Space',' ']]) await send('Input.dispatchKeyEvent',{type:'keyUp',code,key});
    const blocked=await evaluate('window.__encounter()');
    if(JSON.stringify(blocked.player)!==JSON.stringify(defeated.player) || blocked.activeSpells!==0 || blocked.combat.dodgeTime!==0) throw new Error('Defeated player accepted gameplay input');
    await evaluate('document.querySelector("[data-player-retry]").click()');
    const retry=await evaluate('window.__encounter()');
    if(retry.combat.health!==100 || retry.combat.hits!==0 || retry.enemy.health!==100 || retry.player.some(v=>v!==0) || retry.activeSpells!==0) throw new Error('Retry did not restore encounter');
    await send('Input.dispatchKeyEvent',{type:'keyDown',code:'KeyD',key:'d'});
    await delay(300);
    await send('Input.dispatchKeyEvent',{type:'keyUp',code:'KeyD',key:'d'});
    if((await evaluate('window.__encounter().player'))[0]<0.2) throw new Error('Retry did not restore movement');
    console.log('Live health, defeat input lock and retry passed');
  }
  for (const preset of ['fog', 'sand', 'snow', 'grass', 'sand']) {
    await evaluate(`(() => {const s=document.querySelector('[data-select="material-preset"]'); s.value='${preset}'; s.dispatchEvent(new Event('change'));})()`);
    await delay(1500);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w' });
    await delay(1800);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 660, y: 420, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 660, y: 420, button: 'left', clickCount: 1 });
    await delay(1000);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile('material-' + preset + '.png', Buffer.from(shot.data, 'base64'));
    console.log(preset, await evaluate('document.querySelector("[data-metric=state]")?.textContent'), 'errors:', errors.length);
  }
  if (errors.length) throw new Error(JSON.stringify(errors));
} finally { ws.close(); chrome.kill(); }
// Chrome can retain inherited process handles briefly after termination.
process.exit(0);




