import { FogLightingLab } from './FogLightingLab';
import { attackEnvelope } from './AttackEnvelope';
import { EncounterScene } from './EncounterScene';
import { roomContains, moveInDungeon } from './DungeonLayout';
import { demoTerrain, intersectTerrain } from './TerrainHeight';
import * as THREE from 'three/webgpu';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { BenchmarkUI, type BenchmarkMetrics, type BenchmarkSettings } from './BenchmarkUI';
import { FluidFire } from './FluidFire';
import {
  getGroundFlowInteractionProfile,
  GroundFlowVolume,
  type GroundFlowMaterialPreset,
} from './GroundFlowVolume';
import './style.css';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
const unsupported = document.querySelector<HTMLElement>('#unsupported');

if (!canvas || !unsupported) throw new Error('Application shell is incomplete.');

if (!WebGPU.isAvailable()) {
  canvas.hidden = true;
  unsupported.hidden = false;
} else {
  void start(canvas);
}

async function start(stage: HTMLCanvasElement): Promise<void> {
  const renderer = new THREE.WebGPURenderer({
    canvas: stage,
    antialias: true,
    trackTimestamp: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x07090c, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.82;
  renderer.info.autoReset = false;
  await renderer.init();

  const scene = new THREE.Scene();
  // The localized volume owns its own attenuation; do not use scene-wide fog.
  scene.fog = null;

  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.05, 60);
  camera.position.set(0, 4.8, 8.6);
  camera.lookAt(0, 0.45, 0);

  scene.add(new THREE.HemisphereLight(0xa7bfce, 0x283329, 0.8));
  const keyLight = new THREE.DirectionalLight(0x7faaff, 2.1);
  keyLight.position.set(-4, 7, 3);
  scene.add(keyLight);
  const fogLightDirection = new THREE.Vector3();
  keyLight.getWorldDirection(fogLightDirection);

  const player = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.22, 1.15, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0xdbeaff, roughness: 0.5, metalness: 0.05 }),
  );
  player.position.set(0, demoTerrain.sample(0, 0) + 0.96, 0);
  scene.add(player);

  const obstacle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.72, 0.86, 0.9, 20),
    new THREE.MeshStandardMaterial({ color: 0x283442, roughness: 0.9, metalness: 0.08 }),
  );
  obstacle.position.set(1.65, demoTerrain.sample(1.65, -2.2) + 0.45, -2.2);
  scene.add(obstacle);

  // These are world-space environmental sources, not offsets from the player.
  // In game they will come from level masks, spells and replicated actors.
  const flowSources = [
    { position: new THREE.Vector3(-2.8, 0, -1.6), radius: 2.35, density: 0.95, velocity: new THREE.Vector3(0.14, 0, -0.04) },
    { position: new THREE.Vector3(2.5, 0, -2.7), radius: 1.85, density: 0.8, velocity: new THREE.Vector3(-0.08, 0, 0.12) },
    { position: new THREE.Vector3(1.1, 0, 2.8), radius: 2.1, density: 0.7, velocity: new THREE.Vector3(0.05, 0, -0.1) },
  ];
  const groundWind = new THREE.Vector3(0.24, 0, -0.08);
  const spellSources: Array<{
    position: THREE.Vector3;
    velocity: THREE.Vector3;
    radius: number;
    density: number;
    remaining: number;
    blastRemaining: number;
    blastDuration: number;
    residueDelay: number;
    blastRadius: number;
    blastSpeed: number;
    forward: THREE.Vector2;
    slashWidth: number;
  }> = [];

  let settings: BenchmarkSettings = { resolution: 256, particleCount: 100_000 };
  let materialPreset: GroundFlowMaterialPreset = 'fog';
  let encounterEnabled = true;
  let interactionProfile = getGroundFlowInteractionProfile(materialPreset);
  const createGroundFlow = (): { fire: FluidFire; volume: GroundFlowVolume } => {
    keyLight.color.set(!encounterEnabled && materialPreset === 'fog' ? 0x7faaff : 0xf1e4ce);
    const nextFire = new FluidFire(scene, renderer, { ...settings, width: 14, height: 14 });
    nextFire.parameters.buoyancy = 0;
    nextFire.parameters.vorticity = 8;
    nextFire.parameters.dissipation = 0.999;
    nextFire.parameters.cooling = 0.996;
    nextFire.parameters.injectionRadius = 0.08;
    nextFire.parameters.injectionDensity = 1.2;
    nextFire.parameters.injectionTemperature = 0.18;
    nextFire.parameters.velocityStrength = 0;
    nextFire.parameters.groundFlow = true;
    nextFire.parameters.dynamicFog = false;
    nextFire.setVisualsVisible(false);
    const volume = new GroundFlowVolume(nextFire, renderer, { height: 1.15, lookAhead: 1.25, terrain: demoTerrain });
    volume.setLighting(
      new THREE.Color(0.12, 0.17, 0.19),
      new THREE.Color(0.48, 0.60, 0.62),
      fogLightDirection,
    );
    volume.setMaterialPreset(materialPreset);
    volume.setEncounterMode(encounterEnabled);
    scene.add(volume.group);
    return { fire: nextFire, volume };
  };

  let { fire, volume } = createGroundFlow();
  let paused = false;
  let gpuTimingAvailable = renderer.hasFeature('timestamp-query');
  const adapterName = await getAdapterName();

  const ui = new BenchmarkUI(fire, settings, adapterName, {
    onRebuild(nextSettings) {
      const retained = { ...fire.parameters };
      spellSources.length = 0;
      encounter.reset();
      lightLab.reset();
      volume.dispose();
      fire.dispose();
      settings = nextSettings;
      ({ fire, volume } = createGroundFlow());
      Object.assign(fire.parameters, retained);
      fire.setVisualsVisible(false);
      ui.setFire(fire);
      resetMetricWindow();
    },
    onPauseChange(nextPaused) {
      paused = nextPaused;
    },
    onMaterialPresetChange(nextPreset) {
      encounterEnabled = false;
      encounter.setEnabled(false);
      volume.setEncounterMode(false);
      materialPreset = nextPreset;
      keyLight.color.set(nextPreset === 'fog' ? 0x7faaff : 0xfff1db);
      interactionProfile = getGroundFlowInteractionProfile(materialPreset);
      volume.setMaterialPreset(materialPreset);
    },
  });

  const encounter = new EncounterScene(scene, enabled => {
    encounterEnabled = enabled;
    encounter.setEnabled(enabled);
    volume.setMaterialPreset(materialPreset);
    volume.setEncounterMode(enabled);
    if(enabled && !roomContains(player.position.x,player.position.z,0.3)) player.position.set(0,demoTerrain.sample(0,0)+0.96,0);
    keyLight.color.set(enabled || materialPreset !== 'fog' ? 0xfff1db : 0x7faaff);
  }, () => castAttack(player.position.clone().add(new THREE.Vector3(0,0,-2.3))), () => {
    encounter.reset(); spellSources.length=0; lightLab.reset(); movementKeys.clear();
    player.position.set(0,demoTerrain.sample(0,0)+0.96,0);
    player.rotation.set(0,0,0); player.material.emissive.setHex(0);
    playerMotion.set(0,0,0); playerVelocity.set(0,0,0);
  });
  const lightLab = new FogLightingLab(scene);
  if(import.meta.env.DEV) Object.assign(window, {__encounter: () => ({
    enabled:encounterEnabled, camera:encounter.cameraMode, zoom:encounter.zoom,
    treeBend:encounter.maxTreeBend, responsePasses:volume.responseDispatches,
    activeSpells:spellSources.length, radii:spellSources.map(spell=>spell.blastRadius),
    enemy:{health:encounter.enemy.health,hits:encounter.enemy.hits,lastDamage:encounter.enemy.lastDamage},
    combat:{phase:encounter.combat.phase,health:encounter.combat.health,defeated:encounter.combat.defeated,hits:encounter.combat.hits,dodges:encounter.combat.dodges,cooldown:encounter.combat.cooldown,dodgeTime:encounter.combat.dodgeTime},
    player:[player.position.x,player.position.z],
    visible:volume.group.children.filter(object=>object.visible).map(object=>object.name),
  })});
  stage.addEventListener('wheel', event => {
    event.preventDefault();
    encounter.zoom = THREE.MathUtils.clamp(encounter.zoom * Math.exp(event.deltaY * 0.001), 0.65, 1.65);
  }, {passive:false});

  function castAttack(position: THREE.Vector3): void {
    if(encounterEnabled && encounter.combat.defeated) return;
    if (paused || lightLab.freeze) return;
    if(encounterEnabled && (!roomContains(position.x,position.z) || !roomContains(player.position.x,player.position.z))) return;
    const castUv = volume.worldToUv(position);
    if(castUv.x<0 || castUv.x>1 || castUv.y<0 || castUv.y>1) return;
    position.y = demoTerrain.sample(position.x,position.z);
    const powerful = encounter.powerful;
    const radius = powerful ? 5.2 : 2.5;
    const speed = powerful ? 10 : 4;
    const duration = powerful ? 0.42 : 0.24;
    const forward = new THREE.Vector2(position.x-player.position.x,position.z-player.position.z);
    if (forward.lengthSq() < 0.0001) forward.set(0,-1); else forward.normalize();
    const slashWidth = powerful ? 0.48 : 0.3;
    lightLab.attack(position,powerful);
    spellSources.unshift({position:position.clone(),velocity:new THREE.Vector3(),
      radius:radius*0.42,density:powerful?1.25:0.6,remaining:2.4,
      blastRemaining:duration,blastDuration:duration,residueDelay:duration+0.12,
      blastRadius:radius,blastSpeed:speed,forward,slashWidth});
    spellSources.length=Math.min(spellSources.length,5);
    if(encounterEnabled) encounter.attack({position:position.clone(),radius,impulse:speed,duration,forward,width:slashWidth});
  }

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const pointerUv = new THREE.Vector2();
  const previousPointerUv = new THREE.Vector2();
  const pointerDelta = new THREE.Vector2();
  const hit = new THREE.Vector3();
  let hasPreviousPointer = false;
  let previousPointerTime = performance.now();

  stage.addEventListener('pointermove', (event) => {
    if(paused || lightLab.freeze || (encounterEnabled && event.buttons !== 1)) {hasPreviousPointer=false;fire.clearPointer();return;}
    const rect = stage.getBoundingClientRect();
    pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, camera);
    if (!intersectTerrain(raycaster.ray, demoTerrain, hit)) return;

    volume.worldToUv(hit, pointerUv);
    const inside = pointerUv.x >= 0 && pointerUv.x <= 1 && pointerUv.y >= 0 && pointerUv.y <= 1;
    if (!inside) {
      hasPreviousPointer = false;
      fire.clearPointer();
      return;
    }

    const now = performance.now();
    if (hasPreviousPointer) {
      pointerDelta.copy(pointerUv).sub(previousPointerUv);
      fire.injectPointer(pointerUv, pointerDelta, Math.min((now - previousPointerTime) / 1000, 0.1));
      volume.injectSurfacePointer(hit, pointerDelta, Math.min((now - previousPointerTime) / 1000, 0.1));
    }
    previousPointerUv.copy(pointerUv);
    previousPointerTime = now;
    hasPreviousPointer = true;
  });

  window.addEventListener('pointerup', () => {hasPreviousPointer=false;fire.clearPointer();});
  stage.addEventListener('pointerleave', () => {
    hasPreviousPointer = false;
    fire.clearPointer();
  });

  stage.addEventListener('pointerdown', (event) => {
    const rect = stage.getBoundingClientRect();
    pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, camera);
    if(encounterEnabled && raycaster.intersectObject(encounter.enemy.group,true).length) {
      castAttack(encounter.aimAtEnemy(player.position));return;
    }
    if (!intersectTerrain(raycaster.ray, demoTerrain, hit)) return;
    volume.worldToUv(hit, pointerUv);
    if (pointerUv.x < 0 || pointerUv.x > 1 || pointerUv.y < 0 || pointerUv.y > 1) return;

    castAttack(hit.clone());
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const movementKeys = new Set<string>();
  window.addEventListener('keydown', (event) => {
    if ((event.target as HTMLElement).matches('input,select,button,textarea')) return;
    if (event.code === 'Space') {
      event.preventDefault();
      if(!event.repeat) castAttack(player.position.clone().add(new THREE.Vector3(0,0,-2.3)));
    }
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) movementKeys.add(event.code);
    if (['ShiftLeft','ShiftRight'].includes(event.code) && !event.repeat && encounterEnabled && !paused && !lightLab.freeze) {
      event.preventDefault();
      encounter.combat.dodge(new THREE.Vector3(Number(movementKeys.has('KeyD'))-Number(movementKeys.has('KeyA')),0,Number(movementKeys.has('KeyS'))-Number(movementKeys.has('KeyW'))));
    }
  });
  window.addEventListener('keyup', (event) => movementKeys.delete(event.code));
  window.addEventListener('blur', () => movementKeys.clear());

  let previousFrameTime = performance.now();
  let metricStart = previousFrameTime;
  let metricFrames = 0;
  let cpuTotal = 0;
  let displayedFps = 0;
  let displayedCpuMs = 0;
  let computeGpuMs: number | undefined;
  let renderGpuMs: number | undefined;
  let timingResolvePending = false;
  let totalFrames = 0;
  const cameraForward = new THREE.Vector3();
  const playerMotion = new THREE.Vector3();
  const playerVelocity = new THREE.Vector3();
  const profiledVelocity = new THREE.Vector3();

  function resetMetricWindow(): void {
    metricStart = performance.now();
    metricFrames = 0;
    cpuTotal = 0;
    computeGpuMs = undefined;
    renderGpuMs = undefined;
  }

  function estimateGpuDataMb(): number {
    const halfFloatRgbaBytes = 8;
    // Seven fog RGBA16F fields, four Snow/Grass RGBA16F fields,
    // and three Sand RGBA32F fields (state pair plus outgoing flux).
    const fluidBytes = 17 * settings.resolution * settings.resolution * halfFloatRgbaBytes;
    const particleBytes = settings.particleCount * 3 * 4 * Float32Array.BYTES_PER_ELEMENT;
    return (fluidBytes + particleBytes) / (1024 * 1024);
  }

  function resolveGpuTimings(): void {
    if (!gpuTimingAvailable || timingResolvePending) return;
    timingResolvePending = true;
    void Promise.all([
      renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE),
      renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER),
    ])
      .then(([compute, render]) => {
        if (compute !== undefined) computeGpuMs = compute;
        if (render !== undefined) renderGpuMs = render;
      })
      .catch(() => {
        gpuTimingAvailable = false;
        computeGpuMs = undefined;
        renderGpuMs = undefined;
      })
      .finally(() => {
        timingResolvePending = false;
      });
  }

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const deltaSeconds = Math.min((now - previousFrameTime) / 1000, 0.05);
    previousFrameTime = now;
    const cpuStart = performance.now();

    renderer.info.reset();
    if (!paused && !lightLab.freeze) {
      playerMotion.set(
        Number(movementKeys.has('KeyD')) - Number(movementKeys.has('KeyA')),
        0,
        Number(movementKeys.has('KeyS')) - Number(movementKeys.has('KeyW')),
      );
      if (encounterEnabled && encounter.combat.dodgeTime > 0) {
        const dodgeStep=Math.min(deltaSeconds,encounter.combat.dodgeTime);
        playerMotion.normalize().multiplyScalar(Math.max(0,deltaSeconds-dodgeStep)*2.4).addScaledVector(encounter.combat.direction,dodgeStep*7.5);
      } else playerMotion.normalize().multiplyScalar(deltaSeconds * 2.4);
      if(encounterEnabled && encounter.combat.defeated) playerMotion.set(0,0,0);
      if (playerMotion.lengthSq() > 0) {
        if(encounterEnabled) {
          const moved=moveInDungeon(player.position.x,player.position.z,playerMotion.x,playerMotion.z);
          playerMotion.set(moved.x-player.position.x,0,moved.z-player.position.z);
        }
        player.position.add(playerMotion);
        player.position.y = demoTerrain.sample(player.position.x, player.position.z) + 0.96;

      }
      playerVelocity.copy(playerMotion).divideScalar(Math.max(deltaSeconds, 1 / 240));
      if(encounterEnabled) encounter.combat.update(deltaSeconds,player.position,encounter.enemy.group.position,encounter.enemy.health>0);
      player.material.emissive.setHex(!encounterEnabled ? 0 : encounter.combat.hurtTime>0 ? 0x992211 : encounter.combat.dodgeTime>0 ? 0x226699 : 0);
      player.rotation.z=encounterEnabled && encounter.combat.defeated ? Math.PI/2 : 0;
      player.position.y=demoTerrain.sample(player.position.x,player.position.z)+(encounterEnabled && encounter.combat.defeated ? 0.25 : 0.96);
      encounter.update(deltaSeconds);
      camera.getWorldDirection(cameraForward);
      volume.follow(player.position, cameraForward);
      volume.setWind(profiledVelocity.copy(groundWind).multiplyScalar(interactionProfile.windScale));
      volume.setObstacle(0, obstacle.position, 0.8);
      for(let i=0;i<3;i++) {
        if(encounterEnabled) volume.setObstacle(i+1,encounter.treePositions[i]!,0.2);
        else volume.clearObstacle(i+1);
      }
      for (let index = 0; index < flowSources.length; index += 1) {
        const source = flowSources[index]!;
        volume.setFlowStamp(
          index,
          source.position,
          source.radius,
          source.density * (encounterEnabled ? 0.65 : interactionProfile.environmentalDensityScale),
          profiledVelocity.copy(source.velocity).multiplyScalar(interactionProfile.environmentalVelocityScale),
        );
      }
      for (let index = 0; index < 5; index += 1) {
        const spell = spellSources[index];
        if (!spell) {
          volume.clearFlowStamp(flowSources.length + index);
          volume.clearBlast(index);
          continue;
        }
        spell.position.addScaledVector(spell.velocity, deltaSeconds);
        spell.remaining -= deltaSeconds;
        spell.blastRemaining -= deltaSeconds;
        spell.residueDelay -= deltaSeconds;
        if (spell.remaining <= 0) {
          spellSources.splice(index, 1);
          volume.clearFlowStamp(flowSources.length + index);
          volume.clearBlast(index);
          index -= 1;
          continue;
        }
        if (spell.blastRemaining > 0) {
          const burst = attackEnvelope(spell.blastRadius, spell.blastDuration, spell.blastDuration - spell.blastRemaining);
          volume.setSlash(
            index,
            spell.position,
            burst.radius,
            spell.slashWidth,
            spell.forward,
            spell.blastSpeed * burst.strength,
          );
        } else {
          volume.clearBlast(index);
        }
        if (spell.residueDelay > 0) {
          volume.clearFlowStamp(flowSources.length + index);
          continue;
        }
        // Sword cuts leave transported mist and material imprints, not a round emitter.
        volume.clearFlowStamp(flowSources.length + index);
      }
      volume.setPlayerCapsule(player.position, playerVelocity, interactionProfile.playerWakeRadius);
      if (encounterEnabled || materialPreset === 'fog') fire.update(deltaSeconds);
      volume.updateResponses(deltaSeconds);
      volume.sync();
    }
    lightLab.sync(volume,deltaSeconds,!paused && !lightLab.freeze);
    encounter.updateCamera(camera,player.position,deltaSeconds);
    renderer.render(scene, camera);

    cpuTotal += performance.now() - cpuStart;
    metricFrames += 1;
    totalFrames += 1;
    const metricDuration = now - metricStart;
    if (metricDuration >= 400) {
      displayedFps = (metricFrames * 1000) / metricDuration;
      displayedCpuMs = cpuTotal / metricFrames;
      metricFrames = 0;
      cpuTotal = 0;
      metricStart = now;

      const metrics: BenchmarkMetrics = {
        fps: displayedFps,
        cpuMs: displayedCpuMs,
        computeGpuMs,
        renderGpuMs,
        dispatches: paused || lightLab.freeze ? 0 : (encounterEnabled || materialPreset === 'fog' ? fire.dispatchesPerFrame : 0) + volume.responseDispatches,
        memoryMb: estimateGpuDataMb(),
      };
      ui.update(metrics);
    }

    if (totalFrames % 30 === 0) resolveGpuTimings();
  });
}

async function getAdapterName(): Promise<string> {
  try {
    const adapter = await navigator.gpu.requestAdapter();
    const info = adapter?.info;
    return info?.description || info?.device || info?.vendor || 'WebGPU adapter';
  } catch {
    return 'WebGPU adapter';
  }
}
