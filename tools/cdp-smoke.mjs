const endpoint = process.argv[2] ?? 'http://127.0.0.1:9333';
const waitMs = Number(process.argv[3] ?? 12000);
const screenshotPath = process.argv[4];

const targets = await fetch(`${endpoint}/json`).then((response) => response.json());
const page = targets.find((target) => target.type === 'page' && target.url.includes('127.0.0.1'));
if (!page) throw new Error('The Fluid Fire page was not found in Chrome.');

const socket = new WebSocket(page.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
const diagnostics = [];

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }

  if (message.method === 'Runtime.exceptionThrown') {
    diagnostics.push({ type: 'exception', value: message.params.exceptionDetails });
  } else if (message.method === 'Log.entryAdded') {
    diagnostics.push({ type: 'log', value: message.params.entry });
  } else if (message.method === 'Runtime.consoleAPICalled') {
    const args = message.params.args.map((argument) => argument.value ?? argument.description);
    diagnostics.push({ type: `console.${message.params.type}`, value: args });
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

function command(method, params = {}) {
  sequence += 1;
  socket.send(JSON.stringify({ id: sequence, method, params }));
  return new Promise((resolve) => pending.set(sequence, resolve));
}

await command('Runtime.enable');
await command('Log.enable');
await command('Page.enable');
await command('Page.reload', { ignoreCache: true });
if (
  process.env.CDP_SHOW_FIELD === '1'
  || process.env.CDP_REBUILD_TEST === '1'
  || process.env.CDP_POINTER_TEST === '1'
  || process.env.CDP_MOVE_TEST === '1'
  || process.env.CDP_SPELL_TEST === '1'
  || process.env.CDP_DYNAMIC_FOG === '1'
  || process.env.CDP_FOG_MODE
  || Boolean(process.env.CDP_RENDER_FRACTION)
) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (process.env.CDP_SHOW_FIELD === '1') {
  await command('Runtime.evaluate', {
    expression: `document.querySelector('[data-toggle="field"]')?.click()`,
  });
}
if (process.env.CDP_DYNAMIC_FOG === '1') {
  await command('Runtime.evaluate', {
    expression: `document.querySelector('[data-toggle="fog"]')?.click()`,
  });
}
if (process.env.CDP_FOG_MODE) {
  await command('Runtime.evaluate', {
    expression: `(() => {
      const select = document.querySelector('[data-select="fog-mode"]');
      if (!select) return;
      select.value = ${JSON.stringify(process.env.CDP_FOG_MODE)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`,
  });
}
if (process.env.CDP_RENDER_FRACTION) {
  await command('Runtime.evaluate', {
    expression: `(() => {
      const input = document.querySelector('[data-key="renderFraction"]');
      input.value = ${JSON.stringify(process.env.CDP_RENDER_FRACTION)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  });
}
if (process.env.CDP_REBUILD_TEST === '1') {
  await command('Runtime.evaluate', {
    expression: `(() => {
      const resolution = document.querySelector('[data-select="resolution"]');
      const particles = document.querySelector('[data-select="particles"]');
      resolution.value = '160';
      particles.value = '50000';
      resolution.dispatchEvent(new Event('change', { bubbles: true }));
    })()`,
  });
}
if (process.env.CDP_POINTER_TEST === '1') {
  for (let step = 0; step <= 12; step += 1) {
    await command('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 620 + step * 15,
      y: 540 - step * 7,
      button: 'none',
      buttons: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
}
if (process.env.CDP_MOVE_TEST === '1') {
  await command('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  await new Promise((resolve) => setTimeout(resolve, 2600));
  await command('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
}
if (process.env.CDP_SPELL_TEST === '1') {
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: 805, y: 390, button: 'left', buttons: 1, clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 805, y: 390, button: 'left', buttons: 0, clickCount: 1 });
}
await new Promise((resolve) => setTimeout(resolve, waitMs));

const evaluation = await command('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    uiReady: Boolean(document.querySelector('.benchmark-ui')),
    bodyText: document.body?.innerText?.slice(0, 240),
    unsupported: !document.querySelector('#unsupported')?.hidden,
    fps: document.querySelector('[data-metric="fps"]')?.textContent,
    compute: document.querySelector('[data-metric="compute"]')?.textContent,
    render: document.querySelector('[data-metric="render"]')?.textContent,
    state: document.querySelector('[data-metric="state"]')?.textContent,
    resolution: document.querySelector('[data-select="resolution"]')?.value,
    particles: document.querySelector('[data-select="particles"]')?.value,
    field: document.querySelector('[data-toggle="field"]')?.checked,
    dynamicFog: document.querySelector('[data-toggle="fog"]')?.checked,
    fogMode: document.querySelector('[data-select="fog-mode"]')?.value,
    renderFraction: document.querySelector('[data-key="renderFraction"]')?.value,
    canvas: [document.querySelector('canvas')?.width, document.querySelector('canvas')?.height],
    webgpu: Boolean(navigator.gpu)
  })`,
  returnByValue: true,
});

if (screenshotPath) {
  const screenshot = await command('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(screenshotPath, Buffer.from(screenshot.result.data, 'base64'));
}

console.log(JSON.stringify({
  page: JSON.parse(evaluation.result.result.value),
  diagnostics,
}, null, 2));

socket.close();

try {
  const version = await fetch(`${endpoint}/json/version`).then((response) => response.json());
  const browserSocket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve) => browserSocket.addEventListener('open', resolve, { once: true }));
  browserSocket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
} catch {
  // The smoke-test result is still valid if Chrome already exited.
}
