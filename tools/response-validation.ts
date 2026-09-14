import * as THREE from 'three/webgpu';
import { GroundResponseField } from '../src/GroundResponseField';

/** Diagnostic readback only: verify persistent snow and recovering grass. */
export async function validateResponses() {
  const renderer = new THREE.WebGPURenderer();
  await renderer.init();
  const n = 32;
  const snow = new GroundResponseField(renderer, {kind: 'snow', resolution: n, width: 4, depth: 4});
  const grass = new GroundResponseField(renderer, {kind: 'grass', resolution: n, width: 4, depth: 4});
  const read = async (field: GroundResponseField) => {
    const buffer = await (renderer.backend as any).copyTextureToBuffer(field.fields[field.currentIndex], 0, 0, n, n);
    return Float32Array.from(new Uint16Array(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, n*n*4), THREE.DataUtils.fromHalfFloat);
  };
  const assert = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
  const step = (field: GroundResponseField, count: number) => { for (let i = 0; i < count; i++) field.update(1/60, true); };
  const center = (16*n+16)*4;
  try {
    snow.setStamp(0, new THREE.Vector2(0.5, 0.5), 0.2, 1);
    step(snow, 30);
    const packed = await read(snow);
    assert(packed[center]! < -0.07 && packed[center+1]! > 0.8, 'Snow contact must form a packed imprint');
    snow.clearStamp(0);
    step(snow, 120);
    const retained = await read(snow);
    assert(Math.abs(retained[center]! - packed[center]!) < 0.001, 'Snow height must persist after release');
    snow.setDeposit(0, new THREE.Vector2(0.5, 0.5), 0.2, 4);
    step(snow, 60);
    const filled = await read(snow);
    assert(filled[center]! > retained[center]! + 0.06, 'Fresh snow must fill the imprint');
    assert(filled[center+1]! < retained[center+1]! * 0.25, 'Fresh snow must cover packed shading');

    grass.setStamp(0, new THREE.Vector2(0.5, 0.5), 0.2, 1, new THREE.Vector2(2, 0));
    step(grass, 30);
    const bent = await read(grass);
    assert(bent[center+1]! > 0.8 && bent[center+2]! > 0.2, 'Grass contact must flatten and bend');
    grass.clearStamp(0);
    for (let i = 0; i < 20; i++) grass.update(1/60, false);
    const frozen = await read(grass);
    assert(frozen.every((value, i) => value === bent[i]), 'Inactive grass must remain frozen');
    step(grass, 240);
    const recovered = await read(grass);
    assert(recovered[center+1]! < 0.06 && Math.abs(recovered[center+2]!) < 0.001, 'Grass must recover after contact');
    return {snow: 'imprint retention and fresh powder passed', grass: 'bend, freeze and recovery passed'};
  } finally { snow.dispose(); grass.dispose(); renderer.dispose(); }
}
