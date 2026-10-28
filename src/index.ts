/**
 * ninja3js — stylised ground mist, fluid and ground-response effects for Three.js WebGPU.
 *
 * Library surface (what a host application imports). The browser demo under src/main.ts,
 * the training chamber, the sentinel and the benchmark UI stay outside this entry.
 *
 *   import { GroundMist } from 'ninja3js';
 *   const mist = new GroundMist(renderer, { width: 16, depth: 16, height: 0.9 });
 *   scene.add(mist.group);
 *   mist.setAmbient(0.4);
 *   mist.blast(position, 2.5, 4);
 *   mist.update(dt); // every frame, before renderer.render()
 */
export { GroundMist } from './GroundMist';
export type { GroundMistOptions, MistEmitOptions } from './GroundMist';
export { FluidFire, DEFAULT_FLUID_BOUNDS } from './FluidFire';
export type { FluidFireOptions, FluidFireParameters, FluidEmitterOptions, FluidBounds, FogRenderMode } from './FluidFire';
export { GroundFlowVolume, getGroundFlowInteractionProfile } from './GroundFlowVolume';
export type { GroundFlowVolumeOptions, GroundFlowMaterialPreset, GroundFlowInteractionProfile } from './GroundFlowVolume';
export { GroundResponseField } from './GroundResponseField';
export type { GroundResponseKind } from './GroundResponseField';
export { SimulationWindow } from './SimulationWindow';
export type { SimulationWindowOptions, SimulationWindowShift } from './SimulationWindow';
export { flatTerrain, demoTerrain, intersectTerrain } from './TerrainHeight';
export type { TerrainHeight } from './TerrainHeight';
export { attackEnvelope } from './AttackEnvelope';
export { slashDistance, slashDistanceNode, slashProfile } from './SlashShape';
