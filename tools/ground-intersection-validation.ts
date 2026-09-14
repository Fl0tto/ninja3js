import * as THREE from 'three/webgpu';
import { FluidFire } from '../src/FluidFire';
import { GroundFlowVolume } from '../src/GroundFlowVolume';

// Isolate terrain from mist, props and transient attack rings for visual review.
export async function validateGround() {
  const renderer = new THREE.WebGPURenderer({antialias: true});
  renderer.setSize(1000, 700);
  await renderer.init();
  renderer.domElement.style.cssText = 'position:fixed;inset:0;z-index:99999';
  document.body.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x18232d);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x405040, 2));
  const sun = new THREE.DirectionalLight(0xffefdc, 3);
  sun.position.set(-3, 6, 4);
  scene.add(sun);
  const flow = new FluidFire(scene, renderer, {resolution: 160, particleCount: 1000, width: 14, height: 14});
  flow.group.visible = false;
  flow.parameters.groundVolume = true;
  const volume = new GroundFlowVolume(flow, renderer);
  scene.add(volume.group);
  volume.setEncounterMode(true);
  const internal = volume as any;
  const camera = new THREE.PerspectiveCamera(48, 1000 / 700, 0.05, 100);
  const assert = (ok: boolean, message: string) => {if (!ok) throw new Error(message);};
  const sync = () => {
    volume.sync();
    assert(internal.passiveGround.visible, 'Continuous terrain must be visible');
    for (const kind of ['sand', 'snow']) {
      const response = internal.responses[kind];
      assert(internal.groundTextures[kind].value === response.fields[response.currentIndex], 'Ground must bind the latest ' + kind + ' field');
      assert(internal.flowSurfaces[kind].every((mesh: THREE.Mesh) => !mesh.visible), 'Separate surfaces must not overlap encounter ground');
    }
    internal.fogVolumes.forEach((mesh: THREE.Mesh) => mesh.visible = false);
    internal.grassBlades.forEach((mesh: THREE.Mesh) => mesh.visible = false);
  };
  // Sustained contacts excavate both materials, including the blended borders.
  for (const kind of ['sand', 'snow']) {
    const field = internal.responses[kind];
    const center = new THREE.Vector3(kind === 'sand' ? -2.1 : 2.1, 0, -1.4);
    field.setStamp(0, volume.worldToUv(center), 1.8 / 14, 1, new THREE.Vector2(3, 0));
  }
  for (let i = 0; i < 90; i++) {volume.updateResponses(1 / 60); sync();}
  for (const kind of ['sand', 'snow']) internal.responses[kind].clearStamp(0);
  const snow = internal.responses.snow;
  const bytes = await (renderer.backend as any).copyTextureToBuffer(snow.fields[snow.currentIndex], 0, 0, 160, 160);
  const values = new Uint16Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, 160 * 160 * 4);
  let minimum = 0;
  for (let i = 0; i < values.length; i += 4) minimum = Math.min(minimum, THREE.DataUtils.fromHalfFloat(values[i]!));
  assert(minimum < -0.07, 'Test must excavate below the old underlying soil');
  const render = async (view: 'overworld' | 'dungeon') => {
    camera.position.set(0, view === 'overworld' ? 8 : 1.3, view === 'overworld' ? 5 : 5.2);
    camera.lookAt(0, 0, -1.4);
    sync();
    await renderer.renderAsync(scene, camera);
  };
  await render('overworld');
  return {
    minimumSnowHeight: minimum,
    render,
    checkScroll: async () => {
      volume.follow(new THREE.Vector3(2.5, 0, 0));
      volume.updateResponses(0);
      sync();
      await render('dungeon');
    },
    dispose: () => {volume.dispose(); flow.dispose(); renderer.dispose(); renderer.domElement.remove();},
  };
}
