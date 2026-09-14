import * as THREE from 'three';
import { float } from 'three/tsl';

/** CPU and GPU samplers must describe the same world-space height field. */
export interface TerrainHeight {
  /** Conservative world-height bounds used by the fog proxy. */
  bounds?: readonly [number, number];
  sample(x: number, z: number): number;
  node(xz: any): any;
}

export const flatTerrain: TerrainHeight = { bounds: [0, 0], sample: () => 0, node: () => float(0) };

/** Smooth, unbounded demo landscape; applications can supply their own sampler. */
export const demoTerrain: TerrainHeight = {
  bounds: [-1.15, 1.15],
  sample: (x, z) => 0.8 * Math.sin(x * 0.22) * Math.cos(z * 0.18)
    + 0.35 * Math.sin(z * 0.38 + x * 0.12),
  node: xz => xz.x.mul(0.22).sin().mul(xz.y.mul(0.18).cos()).mul(0.8)
    .add(xz.y.mul(0.38).add(xz.x.mul(0.12)).sin().mul(0.35)),
};

/** First crossing of the base terrain, refined without GPU state readback. */
export function intersectTerrain(ray: THREE.Ray, terrain: TerrainHeight, target: THREE.Vector3, far = 60): boolean {
  const point = new THREE.Vector3();
  const distance = (t: number): number => {
    ray.at(t, point);
    return point.y - terrain.sample(point.x, point.z);
  };
  let previous = distance(0);
  for (let t = 0.25; t <= far; t += 0.25) {
    const next = distance(t);
    if (previous * next <= 0) {
      let low = t - 0.25, high = t;
      for (let i = 0; i < 16; i++) {
        const middle = (low + high) / 2;
        if (distance(middle) * previous > 0) low = middle;
        else high = middle;
      }
      ray.at((low + high) / 2, target);
      return true;
    }
    previous = next;
  }
  return false;
}
