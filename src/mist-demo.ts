/**
 * The smallest useful host: a lit arena floor, two capsules walking through ground mist, a
 * blast every few seconds and a warm smoke source. Everything the host does goes through the
 * GroundMist world-unit API; nothing here knows about textures or UVs. A sword slash and a swirl
 * take turns with the blast so every force primitive has a smoke path.
 *
 * `window.__mist` exposes the objects for the headless smoke (tools/mist-smoke.mjs).
 */
import * as THREE from 'three/webgpu';
import { GroundMist } from './index';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const hud = document.querySelector<HTMLDivElement>('#hud')!;

const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
await renderer.init();
if (!GroundMist.isSupported(renderer)) {
  hud.textContent = 'WebGPU is required for the fluid solver (WebGL2 fallback active).';
  throw new Error('GroundMist needs the WebGPU backend');
}
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0b1016');
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 5.5, -11);
camera.lookAt(0, 0.6, 0);

const sun = new THREE.DirectionalLight('#ffffff', 2.4);
sun.position.set(5, 10, -3);
scene.add(sun, new THREE.AmbientLight('#8fa6c7', 0.8));
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardNodeMaterial({ color: new THREE.Color('#3a4a3a'), roughness: 0.95 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const walker = (color: string, x: number) => {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 4, 12), new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(color) }));
  m.position.set(x, 0.8, 0);
  scene.add(m);
  return m;
};
const a = walker('#4a8cff', -3);
const b = walker('#ff6b4a', 3);

const mist = new GroundMist(renderer, { width: 16, depth: 16, height: 0.9, resolution: 128 });
mist.setAmbient(0.45);
mist.setPalette('#dfe7f1', '#ff9a4a');
mist.setLighting('#0b1420', '#9fb6d6', new THREE.Vector3(-0.5, -1, 0.3));
scene.add(mist.group);

let t = 0;
let last = performance.now();
let frames = 0;
let nextBlast = 2;
let forceCycle = 0;
const velocity = new THREE.Vector3();
const prevA = a.position.clone();
const prevB = b.position.clone();
const smoke = new THREE.Vector3(2, 0.2, 2);

function tick(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  t += dt;
  frames++;
  a.position.set(Math.sin(t * 0.6) * 4, 0.8, Math.cos(t * 0.6) * 3);
  b.position.set(-Math.sin(t * 0.45) * 3.5, 0.8, -Math.cos(t * 0.45) * 3.5);
  for (const [key, m, prev] of [['a', a, prevA], ['b', b, prevB]] as const) {
    velocity.subVectors(m.position, prev).divideScalar(Math.max(dt, 1 / 240));
    mist.mover(key, m.position, velocity, 0.6);
    prev.copy(m.position);
  }
  mist.emit(smoke, 0.7, 0.9, { heat: 1.2, velocity: new THREE.Vector3(0.3, 0, 0.1) }, 'smoke');
  if (t > nextBlast) {
    nextBlast = t + 3.5;
    const phase = forceCycle++ % 3;
    if (phase === 0) mist.blast(new THREE.Vector3(0, 0, 0), 2.5, 5, 0.3);
    else if (phase === 1) mist.slash(new THREE.Vector3(0, 0, 0), t * 0.7, 2.2, 0.5, 9, 0.25);
    else mist.vortex(new THREE.Vector3(0, 0, 0), 3, 4, 0.6, 1.6);
    mist.setPointLight(0, new THREE.Vector3(0, 0.5, 0), '#ffd8a0', 6, 4);
  }
  mist.setPointLight(0, new THREE.Vector3(0, 0.5, 0), '#ffd8a0', Math.max(0, 6 - (t - (nextBlast - 3.5)) * 8), 4);
  mist.update(dt);
  renderer.render(scene, camera);
  hud.textContent = `ninja3js GroundMist · ${mist.solver.resolution}² field · ${mist.solver.dispatchesPerFrame} dispatches/frame · frame ${frames}`;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

(window as unknown as { __mist: unknown }).__mist = { mist, renderer, scene, camera, frames: () => frames };
