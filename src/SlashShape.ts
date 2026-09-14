import { float, vec2 } from 'three/tsl';

/** Curved blade in the tangent/forward plane; CPU and GPU share this profile. */
export function slashProfile(across: number, halfLength: number, width: number) {
  const t = Math.max(-1, Math.min(1, across / halfLength));
  return {across: t * halfLength, bow: 0.22 * halfLength * (1-t*t), width: width * (0.15+0.85*(1-t*t))};
}
export function slashDistance(x: number, z: number, forwardX: number, forwardZ: number, halfLength: number, width: number) {
  const across = x * -forwardZ + z * forwardX;
  const along = x * forwardX + z * forwardZ;
  const p = slashProfile(across, halfLength, width);
  return Math.hypot(across-p.across, along-p.bow) / p.width;
}
export function slashDistanceNode(offset: any, forward: any, halfLength: any, width: any): any {
  const across = offset.dot(vec2(forward.y.negate(), forward.x));
  const along = offset.dot(forward);
  const t = across.div(halfLength.max(0.001)).clamp(-1,1);
  const curve = float(1).sub(t.mul(t));
  return vec2(across.sub(t.mul(halfLength)), along.sub(curve.mul(halfLength).mul(0.22))).length()
    .div(width.max(0.001).mul(curve.mul(0.85).add(0.15)));
}
