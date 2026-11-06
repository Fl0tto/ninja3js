import * as THREE from 'three/webgpu';
import type { UniformNode } from 'three/webgpu';
import {
  If,
  Loop,
  cameraPosition,
  exp,
  float,
  mix,
  positionWorld,
  screenCoordinate,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { flatTerrain, type TerrainHeight } from './TerrainHeight';

type TSLNode = any;

/** A live TSL uniform node; hosts only ever touch `.value`, the march reads it as a node. */
export type MistUniform<T> = T extends THREE.Vector2 ? UniformNode<'vec2', THREE.Vector2>
  : T extends THREE.Vector4 ? UniformNode<'vec4', THREE.Vector4>
  : T extends THREE.Color ? UniformNode<'color', THREE.Color>
  : UniformNode<'float', number>;
/** An integer uniform (the march's step count); typed by hand because older typings lack the 'int' overload. */
export type MistIntUniform = UniformNode<'int', number>;
const intUniform = (value: number): MistIntUniform => (uniform as unknown as (v: number, t: string) => MistIntUniform)(value, 'int');

/** One of the three local scattering lights the march evaluates per step. */
export interface MistPointLight {
  /** XYZ world position, W range in metres. */
  positionRange: MistUniform<THREE.Vector4>;
  /** Tint times intensity; black means unused. */
  radiance: MistUniform<THREE.Color>;
}

/**
 * Everything the mist march needs to know about one field window, as live uniforms. GroundMist
 * owns one by default; a host that composites the mist in its own pass creates one with
 * `createMistFrame()`, hands it to every `GroundMist` it builds (`{ frame }`), and binds it once:
 * window size, placement, heights and look are all uniforms, so one compiled program serves an
 * arena one minute and a scrolling overworld window the next. Only the terrain sampler is baked
 * into the shader; a frame shared between windows keeps one terrain.
 */
export interface MistFrame {
  /** World X/Z of the window centre (texture V maps to +Z). */
  worldCenter: MistUniform<THREE.Vector2>;
  /** World extent of the window (width along X, depth along Z), metres. */
  extent: MistUniform<THREE.Vector2>;
  /** Metres per cell on each axis (extent / resolution), for cells-per-second ↔ metres-per-second. */
  cellSize: MistUniform<THREE.Vector2>;
  /** X: mist floor above the terrain, Y: mist ceiling above the terrain, Z/W: the terrain's lowest and highest height. Metres. */
  heights: MistUniform<THREE.Vector4>;
  /** Terrain the mist hugs; flat when a host has none. */
  terrain: TerrainHeight;
  /** Hard world-space X/Z edge (a room); ±1e6 when the window edge is the only limit. */
  boundsMin: MistUniform<THREE.Vector2>;
  boundsMax: MistUniform<THREE.Vector2>;
  steps: MistIntUniform;
  jitter: MistUniform<number>;
  lightColor: MistUniform<THREE.Color>;
  ambientColor: MistUniform<THREE.Color>;
  lightUvDirection: MistUniform<THREE.Vector2>;
  baseTint: MistUniform<THREE.Color>;
  hotTint: MistUniform<THREE.Color>;
  densityEdge: MistUniform<THREE.Vector2>;
  opticalDepthScale: MistUniform<number>;
  opacityScale: MistUniform<number>;
  heightLobes: MistUniform<number>;
  pointLights: readonly MistPointLight[];
}

export interface MistFrameOptions {
  width?: number;
  depth?: number;
  resolution?: number;
  baseHeight?: number;
  height?: number;
  terrain?: TerrainHeight;
}

/** Writes a window's size and heights into a frame; GroundMist calls it, a host may too. */
export function setMistFrameWindow(frame: MistFrame, options: Required<Omit<MistFrameOptions, 'terrain'>>): void {
  frame.extent.value.set(options.width, options.depth);
  frame.cellSize.value.set(options.width / options.resolution, options.depth / options.resolution);
  const [terrainMin, terrainMax] = frame.terrain.bounds ?? [-4, 4];
  frame.heights.value.set(options.baseHeight, options.height, terrainMin, terrainMax);
}

/** Builds a frame with GroundMist's defaults; a host that composites the mist itself owns one. */
export function createMistFrame(options: MistFrameOptions = {}): MistFrame {
  const frame: MistFrame = {
    worldCenter: uniform(new THREE.Vector2()),
    extent: uniform(new THREE.Vector2(16, 16)),
    cellSize: uniform(new THREE.Vector2(16 / 128, 16 / 128)),
    heights: uniform(new THREE.Vector4(0.02, 0.9, -4, 4)),
    terrain: options.terrain ?? flatTerrain,
    boundsMin: uniform(new THREE.Vector2(-1e6, -1e6)),
    boundsMax: uniform(new THREE.Vector2(1e6, 1e6)),
    steps: intUniform(48),
    jitter: uniform(1),
    lightColor: uniform(new THREE.Color(0.55, 0.65, 0.8)),
    ambientColor: uniform(new THREE.Color(0.05, 0.07, 0.11)),
    lightUvDirection: uniform(new THREE.Vector2(-0.42, 0.34)),
    baseTint: uniform(new THREE.Color(1, 1, 1)),
    hotTint: uniform(new THREE.Color(1, 0.6, 0.3)),
    densityEdge: uniform(new THREE.Vector2(0.035, 0.22)),
    opticalDepthScale: uniform(4.2),
    opacityScale: uniform(1),
    heightLobes: uniform(0.22),
    pointLights: Array.from({ length: 3 }, () => ({
      positionRange: uniform(new THREE.Vector4(0, 0, 0, 1)),
      radiance: uniform(new THREE.Color(0, 0, 0)),
    })),
  };
  setMistFrameWindow(frame, { width: options.width ?? 16, depth: options.depth ?? 16, resolution: options.resolution ?? 128, baseHeight: options.baseHeight ?? 0.02, height: options.height ?? 0.9 });
  return frame;
}

export interface MistMarchInputs {
  /** The density/heat field (R density, G heat), as a texture node whose value may be re-pointed per frame. */
  field: TSLNode;
  /**
   * Distance along the ray at which the opaque scene starts, metres. GroundMist derives it from
   * `viewportLinearDepth`; a host with its own depth (a G-buffer) passes its reconstruction.
   */
  opaqueDistance: TSLNode;
  /** Ray origin; the camera by default. */
  origin?: TSLNode;
  /** Unit ray direction per pixel; the box proxy's surface direction by default. */
  direction?: TSLNode;
}

/**
 * Samples a field at mip level 0. Typed loosely on purpose: three's typings for `.level()` differ
 * between 0.184 and 0.185, and hosts compile this source with their own `@types/three`.
 */
export function sampleField(field: TSLNode, uv: TSLNode): TSLNode {
  return (texture(field, uv) as TSLNode).level(float(0));
}

/** World X/Z → field UV for a frame; shared by the march and by field samplers. */
export function mistWindowUv(frame: MistFrame, worldXZ: TSLNode): TSLNode {
  return worldXZ.sub(frame.worldCenter).div(frame.extent).add(0.5);
}

/**
 * The ground-mist ray march: integrates the field along one camera ray through the shallow slab
 * above the terrain, with a stylised density edge, world-anchored height lobes, one light-direction
 * density probe as a cheap self-shadow and up to three local scattering lights.
 *
 * Returns `vec4(radiance, opacity)` with radiance un-premultiplied, so a host composites with
 * `colour = mix(colour, radiance, opacity)`.
 */
export function mistMarch(frame: MistFrame, inputs: MistMarchInputs): TSLNode {
  const origin: TSLNode = inputs.origin ?? cameraPosition;
  const direction: TSLNode = inputs.direction ?? positionWorld.sub(cameraPosition).normalize();
  const baseHeight = frame.heights.x;
  const mistHeight = frame.heights.y;
  const bottom = frame.heights.z.add(baseHeight);
  const top = frame.heights.w.add(baseHeight).add(mistHeight);
  const half = frame.extent.mul(0.5);

  const safe = (value: TSLNode): TSLNode => value.greaterThanEqual(0).select(value.max(0.00001), value.min(-0.00001));
  const inverse = vec3(1).div(vec3(safe(direction.x), safe(direction.y), safe(direction.z)));
  const boundsMin = vec3(frame.worldCenter.x.sub(half.x), bottom, frame.worldCenter.y.sub(half.y));
  const boundsMax = vec3(frame.worldCenter.x.add(half.x), top, frame.worldCenter.y.add(half.y));
  const slabA = boundsMin.sub(origin).mul(inverse);
  const slabB = boundsMax.sub(origin).mul(inverse);
  const near = slabA.min(slabB);
  const far = slabA.max(slabB);
  const start = near.x.max(near.y).max(near.z).max(0);
  const end = far.x.min(far.y).min(far.z).min(inputs.opaqueDistance);
  const step = end.sub(start).max(0).div(float(frame.steps));
  const transmittance = float(1).toVar();
  const radiance = vec3(0).toVar();
  const noise = screenCoordinate.xy.dot(vec2(0.06711056, 0.00583715)).fract().mul(52.9829189).fract();
  const offset = mix(float(0.5), noise.mul(0.9).add(0.05), frame.jitter);
  // A ray that never enters the slab (the sky, a wall above it, a surface in front of it) skips the
  // march: in a full-screen pass that is most of the picture.
  If(step.greaterThan(0), () => {
  Loop({ start: 0, end: frame.steps, type: 'int' }, ({ i }: any) => {
    const point = origin.add(direction.mul(start.add(step.mul(float(i).add(offset)))));
    const fieldUv = mistWindowUv(frame, point.xz);
    const sample = sampleField(inputs.field, fieldUv.clamp(0, 1));
    const height = point.y.sub(frame.terrain.node(point.xz)).sub(baseHeight);
    const lobe = point.x.mul(0.83).add(point.z.mul(0.37)).sin().mul(point.z.mul(1.07).sub(point.x.mul(0.21)).sin());
    const localHeight = lobe.mul(frame.heightLobes).add(float(1).sub(frame.heightLobes)).mul(mistHeight);
    const heightProfile = smoothstep(0, 0.06, height).mul(float(1).sub(smoothstep(0.05, localHeight, height)));
    const edge = fieldUv.min(float(1).sub(fieldUv));
    const insideBounds = point.x.greaterThanEqual(frame.boundsMin.x).and(point.x.lessThanEqual(frame.boundsMax.x)).and(point.z.greaterThanEqual(frame.boundsMin.y)).and(point.z.lessThanEqual(frame.boundsMax.y)).select(float(1), float(0));
    const domain = smoothstep(0, 0.07, edge.x.min(edge.y)).mul(insideBounds);
    const breakup = point.x.mul(2.3).add(point.y.mul(4.1)).sin().mul(point.z.mul(2.7).sub(point.y.mul(2.2)).sin()).mul(0.18).add(0.82);
    const density = sample.r.clamp(0, 1.6).mul(smoothstep(frame.densityEdge.x, frame.densityEdge.y, sample.r)).mul(heightProfile).mul(domain).mul(breakup);
    const alpha = float(1).sub(exp(density.mul(step).mul(frame.opticalDepthScale).mul(-0.62))).mul(frame.opacityScale).clamp(0, 1);
    const blocker = sampleField(inputs.field, fieldUv.add(frame.lightUvDirection.mul(0.045)).clamp(0, 1)).r;
    const tint = mix(frame.baseTint, frame.hotTint, smoothstep(0.04, 0.5, sample.g));
    const lighting = mix(frame.ambientColor, frame.lightColor, exp(blocker.mul(-1.1)).mul(0.65).add(0.2)).mul(tint).toVar();
    for (const light of frame.pointLights) {
      const delta = light.positionRange.xyz.sub(point);
      const dist = delta.length();
      const rangeFalloff = float(1).sub(smoothstep(0, light.positionRange.w, dist));
      const attenuation = rangeFalloff.mul(rangeFalloff).div(dist.mul(dist).add(0.35));
      const towardEye = delta.div(dist.max(0.001)).dot(direction.negate()).max(0);
      const phase = towardEye.mul(towardEye).mul(0.35).add(0.65);
      lighting.addAssign(light.radiance.mul(attenuation).mul(phase));
    }
    radiance.addAssign(lighting.mul(alpha).mul(transmittance));
    transmittance.mulAssign(float(1).sub(alpha));
  });
  });
  const opacity = float(1).sub(transmittance);
  return vec4(radiance.div(opacity.max(0.0001)), opacity);
}
