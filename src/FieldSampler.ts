import { float, smoothstep } from 'three/tsl';
import { mistWindowUv, sampleField, type MistFrame } from './MistMarch';

type TSLNode = any;

export interface FieldSampleNodes {
  /** The mist velocity at the point, world metres per second on X/Z (vec2), zero outside the window. */
  velocity: TSLNode;
  /** Density 0..~1.6 at the point, zero outside the window. */
  density: TSLNode;
  /** Heat 0..2 at the point. */
  heat: TSLNode;
  /** 1 inside the window (fading over the outer 6 %), 0 outside. */
  inside: TSLNode;
}

/**
 * Samples a mist window's fields at a world X/Z position, for materials that move with the
 * flow: grass that bends in a player's wake or a blast, a trunk that sways in a swirl. Pass
 * `GroundMist.velocityNode` / `densityNode` (or your own texture nodes) and the mist's `frame`;
 * the nodes are re-pointed per frame, so one material serves every step without a rebuild.
 *
 * Velocity comes back in metres per second (the solver stores cells per second; texture V is +Z).
 */
export function fieldSample(frame: MistFrame, fields: { velocity: TSLNode; density?: TSLNode }, worldXZ: TSLNode): FieldSampleNodes {
  const uv = mistWindowUv(frame, worldXZ);
  const edge = uv.min(float(1).sub(uv));
  const inside = smoothstep(0, 0.06, edge.x.min(edge.y)).mul(uv.x.greaterThanEqual(0).and(uv.x.lessThanEqual(1)).and(uv.y.greaterThanEqual(0)).and(uv.y.lessThanEqual(1)).select(float(1), float(0)));
  const velocity = sampleField(fields.velocity, uv.clamp(0, 1)).xy.mul(frame.cellSize).mul(inside);
  const scalar = fields.density ? sampleField(fields.density, uv.clamp(0, 1)) : null;
  return {
    velocity,
    density: scalar ? scalar.r.mul(inside) : float(0),
    heat: scalar ? scalar.g.mul(inside) : float(0),
    inside,
  };
}
