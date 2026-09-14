import * as THREE from 'three/webgpu';
import { demoTerrain } from './TerrainHeight';
import { attackEnvelope } from './AttackEnvelope';
import { slashDistance, slashProfile } from './SlashShape';
import { ROOM, ROOM_WALLS, roomContains } from './DungeonLayout';
import { TrainingEnemy } from './TrainingEnemy';
import { TrainingCombat } from './TrainingCombat';

export interface WorldAttack {
  position: THREE.Vector3;
  radius: number;
  impulse: number;
  duration: number;
  forward?: THREE.Vector2;
  width?: number;
}

/** Small authored arena and damped vegetation response to world-space attacks. */
export class EncounterScene {
  readonly group = new THREE.Group();
  readonly controls = document.createElement('section');
  cameraMode: 'overworld' | 'dungeon' = 'overworld';
  powerful = false;
  zoom = 1;
  readonly enemy:TrainingEnemy;
  readonly combat:TrainingCombat;
  private readonly wallBoxes:THREE.Box3[]=[];
  private readonly cameraRay=new THREE.Ray();
  private readonly cameraHit=new THREE.Vector3();
  private readonly cameraOffset=new THREE.Vector3();
  private readonly collisionPoint=new THREE.Vector3();
  private readonly strokeGroup=new THREE.ClippingGroup();
  private readonly trees: Array<{pivot: THREE.Group; bend: THREE.Vector2; velocity: THREE.Vector2}> = [];
  private readonly rings: Array<{mesh: THREE.Mesh; age: number; attack: WorldAttack; hitTrees: Set<number>; hitEnemy:boolean}> = [];
  private readonly cameraTarget = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();

  constructor(scene: THREE.Scene, onMode: (encounter: boolean) => void, onCast: () => void, onRetry: () => void = () => this.reset()) {
    scene.add(this.group);
    this.strokeGroup.clippingPlanes=[new THREE.Plane(new THREE.Vector3(1,0,0),-ROOM.left),new THREE.Plane(new THREE.Vector3(-1,0,0),ROOM.right),new THREE.Plane(new THREE.Vector3(0,0,1),-ROOM.back),new THREE.Plane(new THREE.Vector3(0,0,-1),ROOM.front)];
    this.group.add(this.strokeGroup);
    for (const [x, z, scale] of [[-3.2,-2.8,1], [3.2,-2.8,1.15], [0,-4.5,0.85]]) {
      const pivot = new THREE.Group();
      pivot.position.set(x!, demoTerrain.sample(x!,z!), z!);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.10,0.21,2.5,7),
        new THREE.MeshStandardMaterial({color:0x62584b,roughness:1}));
      trunk.position.y=1.25;
      pivot.add(trunk);
      for (let i=0;i<3;i++) {
        const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.95-i*0.15,1),
          new THREE.MeshStandardMaterial({color: i===1?0x506d57:0x344e42,roughness:1}));
        crown.position.set(i===1?0.35:-0.12,2.1+i*0.5,i===1?0.12:0);
        pivot.add(crown);
      }
      pivot.scale.setScalar(scale!);
      this.group.add(pivot);
      this.trees.push({pivot,bend:new THREE.Vector2(),velocity:new THREE.Vector2()});
    }
    // Roofless chamber: continuous collision walls with staggered masonry facing.
    for(const wall of ROOM_WALLS) {
      const base=demoTerrain.sample(wall.x,wall.z);
      const mesh=new THREE.Mesh(new THREE.BoxGeometry(wall.width,4.2,wall.depth),new THREE.MeshStandardMaterial({color:0x414950,roughness:0.94}));
      mesh.position.set(wall.x,base+0.7,wall.z);mesh.name='Dungeon wall';this.group.add(mesh);
      mesh.updateMatrixWorld(true);this.wallBoxes.push(new THREE.Box3().setFromObject(mesh));
      const horizontal=wall.width>wall.depth,length=horizontal?wall.width:wall.depth;
      const count=Math.ceil(length/1.1),unit=length/count;
      for(let row=0;row<4;row++) for(let i=0;i<count;i++) {
        const block=new THREE.Mesh(new THREE.BoxGeometry(horizontal?unit-0.035:wall.width+0.035,0.57,horizontal?wall.depth+0.035:unit-0.035),
          new THREE.MeshStandardMaterial({color:[0x59636b,0x505b63,0x636a6c][(i+row)%3],roughness:0.92}));
        const offset=(i+0.5)*unit-length/2;
        block.position.set(wall.x+(horizontal?offset:0),base+row*0.62+0.3,wall.z+(horizontal?0:offset));
        this.group.add(block);
      }
    }
    const lintel=new THREE.Mesh(new THREE.BoxGeometry(3.1,0.48,0.65),new THREE.MeshStandardMaterial({color:0x73786f,roughness:0.9}));
    lintel.position.set(0,demoTerrain.sample(0,ROOM.front)+2.85,ROOM.front+0.25);
    this.group.add(lintel);lintel.updateMatrixWorld(true);this.wallBoxes.push(new THREE.Box3().setFromObject(lintel));
    this.enemy=new TrainingEnemy(this.group);
    this.combat=new TrainingCombat(this.strokeGroup);
    this.controls.className='encounter-controls';
    this.controls.innerHTML=`<strong>THE TRAINING CHAMBER</strong>
      <label>Scene<select data-encounter="mode"><option value="encounter">Shared encounter</option><option value="diagnostic">Single material</option></select></label>
      <label>Camera<select data-encounter="camera"><option value="overworld">Overworld</option><option value="dungeon">Dungeon</option></select></label>
      <label>Slash<select data-encounter="power"><option value="modest">Modest</option><option value="powerful">Powerful</option></select></label>
      <button data-encounter="cast" type="button">Slash ahead · Space</button>
      <small>Click to aim · WASD move · Shift dodge · Scroll to zoom</small>
      <small data-combat-status>Amber circle warns of a strike · Dodge late or move clear</small>
      <small data-enemy-status>Sentinel · 100 / 100</small><meter data-enemy-health min="0" max="100" value="100" aria-label="Sentinel health"></meter>
      <small data-player-status>Player · 100 / 100</small><meter data-player-health min="0" max="100" value="100" aria-label="Player health"></meter>
      <button data-player-retry type="button">Restart encounter</button>
      <button data-enemy-reset type="button">Reset target</button>`;
    document.body.appendChild(this.controls);
    this.controls.querySelector('[data-encounter="mode"]')!.addEventListener('change',e=>onMode((e.target as HTMLSelectElement).value==='encounter'));
    this.controls.querySelector('[data-encounter="camera"]')!.addEventListener('change',e=>this.cameraMode=(e.target as HTMLSelectElement).value as typeof this.cameraMode);
    this.controls.querySelector('[data-encounter="power"]')!.addEventListener('change',e=>this.powerful=(e.target as HTMLSelectElement).value==='powerful');
    this.controls.querySelector('[data-encounter="cast"]')!.addEventListener('click',onCast);
    this.controls.querySelector('[data-player-retry]')!.addEventListener('click',onRetry);
    this.controls.querySelector('[data-enemy-reset]')!.addEventListener('click',()=>{this.enemy.reset();this.combat.cancel();this.updateEnemyHud();});
  }

  reset(): void {
    this.combat.reset();
    this.enemy.reset();this.updateEnemyHud();
    for(const tree of this.trees) {tree.bend.set(0,0);tree.velocity.set(0,0);tree.pivot.rotation.set(0,0,0);}
    while(this.rings.length) this.removeRing(0);
  }
  get treePositions(): THREE.Vector3[] {return this.trees.map(tree=>tree.pivot.position);}
  get maxTreeBend(): number {return Math.max(...this.trees.map(tree=>tree.bend.length()));}
  setEnabled(enabled:boolean):void {
    this.combat.cancel();
    this.group.visible=enabled;
    (this.controls.querySelector('[data-encounter="mode"]') as HTMLSelectElement).value=enabled?'encounter':'diagnostic';
  }

  attack(attack:WorldAttack):void {
    if(this.combat.defeated) return;
    if(!roomContains(attack.position.x,attack.position.z)) return;
    const powerful = attack.impulse > 4;
    const geometry=attack.forward ? new THREE.PlaneGeometry(1,1,80,1) : new THREE.RingGeometry(powerful ? 0.93 : 0.97,1,80).rotateX(-Math.PI/2);
    const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:powerful?0xffba69:0xa9e4e9,transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide}));
    // Clip the visible stroke to the same convex room as its CPU/GPU responders.
    mesh.position.copy(attack.position);
    this.strokeGroup.add(mesh);
    this.rings.push({mesh,age:0,attack:{...attack,position:attack.position.clone(),forward:attack.forward?.clone()},hitTrees:new Set(),hitEnemy:false});
    if(this.rings.length>5) this.removeRing(0);
  }

  update(dt:number):void {
    this.enemy.update(dt);
    for (const ring of this.rings) {
      const radius = attackEnvelope(ring.attack.radius, ring.attack.duration, ring.age + dt).radius;
      if(!ring.hitEnemy && this.enemy.health>0 && roomContains(this.enemy.group.position.x,this.enemy.group.position.z)) {
        const offset=new THREE.Vector2(this.enemy.group.position.x-ring.attack.position.x,this.enemy.group.position.z-ring.attack.position.z);
        const forward=ring.attack.forward;
        const metric=forward?slashDistance(offset.x,offset.y,forward.x,forward.y,radius,(ring.attack.width??0.3)+0.2):offset.length()/radius;
        if(metric<=1) {ring.hitEnemy=true;this.enemy.hit(ring.attack.impulse,forward??offset.normalize());}
      }
      this.trees.forEach((tree, index) => {
        if (ring.hitTrees.has(index)) return;
        if(!roomContains(tree.pivot.position.x,tree.pivot.position.z)) return;
        const offset = new THREE.Vector2(tree.pivot.position.x-ring.attack.position.x, tree.pivot.position.z-ring.attack.position.z);
        const distance = offset.length();
        const forward = ring.attack.forward;
        const metric = forward ? slashDistance(offset.x,offset.y,forward.x,forward.y,radius,ring.attack.width ?? 0.3) : distance/radius;
        if (metric > 1) return;
        ring.hitTrees.add(index);
        const weight = forward ? Math.max(0.15,1-metric) : Math.max(0, 1-distance/ring.attack.radius);
        if (forward) offset.copy(forward);
        else if (distance < 0.01) offset.set(0,-1); else offset.divideScalar(distance);
        tree.velocity.addScaledVector(offset,weight*ring.attack.impulse*0.28).clampLength(0,3);
      });
    }
    for(const tree of this.trees) {
      // Substep the spring so frame hitches do not amplify recoil.
      const steps=Math.max(1,Math.ceil(dt/(1/120))),h=dt/steps;
      for(let i=0;i<steps;i++) {
        tree.velocity.addScaledVector(tree.bend,-28*h).multiplyScalar(Math.exp(-5*h));
        tree.bend.addScaledVector(tree.velocity,h).clampLength(0,0.32);
      }
      tree.pivot.rotation.set(tree.bend.y,0,-tree.bend.x);
    }
    for(let i=this.rings.length-1;i>=0;i--) {
      const ring=this.rings[i]!;
      ring.age+=dt;
      const progress=ring.age/(ring.attack.duration+0.16);
      if(progress>=1) {this.removeRing(i);continue;}
      const radius=attackEnvelope(ring.attack.radius,ring.attack.duration,ring.age).radius;
      const position=ring.mesh.geometry.attributes.position!;
      // Conform the expanding cue to terrain and the thin material layer.
      for(let j=0;j<position.count;j++) {
        const angle=(j%81)/80*Math.PI*2;
        const r=radius*(j<81?(ring.attack.impulse>4?0.93:0.97):1);
        let x=Math.cos(angle)*r,z=-Math.sin(angle)*r;
        if (ring.attack.forward) {
          const across = ((j%81)/80*2-1)*radius;
          const profile = slashProfile(across,radius,ring.attack.width ?? 0.3);
          const along = profile.bow + profile.width*(j<81?-1:1);
          const forward = ring.attack.forward;
          x = -forward.y*across+forward.x*along;
          z = forward.x*across+forward.y*along;
        }
        position.setXYZ(j,x,demoTerrain.sample(x+ring.attack.position.x,z+ring.attack.position.z)-ring.attack.position.y+0.19,z);
      }
      position.needsUpdate=true;
      ring.mesh.frustumCulled=false;
      (ring.mesh.material as THREE.MeshBasicMaterial).opacity=(1-progress)**2*(ring.attack.impulse>4?0.8:0.5);
    }
    this.updateEnemyHud();
  }

  private updateEnemyHud():void {
    (this.controls.querySelector('[data-player-health]') as HTMLMeterElement).value=this.combat.health;
    this.controls.querySelector('[data-player-status]')!.textContent=this.combat.defeated ? 'Defeated · Retry to return to your starting position' : `Player · ${this.combat.health} / 100`;
    this.controls.querySelector('[data-player-retry]')!.textContent=this.combat.defeated?'Retry encounter':'Restart encounter';
    (this.controls.querySelector('[data-encounter="cast"]') as HTMLButtonElement).disabled=this.group.visible && this.combat.defeated;
    this.controls.querySelector('[data-combat-status]')!.textContent=`${this.combat.phase === 'warning' ? 'Incoming strike!' : 'Shift dodge · '+(this.combat.cooldown > 0 ? 'recharging' : 'ready')} · Hits taken ${this.combat.hits} · Timed dodges ${this.combat.dodges}`;
    if(this.combat.defeated) this.controls.querySelector('[data-combat-status]')!.textContent=`Encounter ended · Hits taken ${this.combat.hits} · Timed dodges ${this.combat.dodges}`;
    (this.controls.querySelector('[data-enemy-health]') as HTMLMeterElement).value=this.enemy.health;
    this.controls.querySelector('[data-enemy-status]')!.textContent=this.enemy.health===0?'Sentinel defeated · resetting…':`Sentinel · ${this.enemy.health} / 100${this.enemy.lastDamage ? ' · Last hit −'+this.enemy.lastDamage : ''}`;
  }

  aimAtEnemy(player:THREE.Vector3):THREE.Vector3 {
    const forward=this.enemy.group.position.clone().sub(player);forward.y=0;
    if(forward.lengthSq()<0.001)forward.set(0,0,-1);else forward.normalize();
    return this.enemy.group.position.clone().addScaledVector(forward,-0.22*(this.powerful?5.2:2.5));
  }

  updateCamera(camera:THREE.PerspectiveCamera,player:THREE.Vector3,dt:number):void {
    this.cameraTarget.copy(player).add(new THREE.Vector3(0,-0.1,-0.7));
    this.cameraPosition.copy(player).add(this.cameraMode==='overworld'
      ?new THREE.Vector3(0,12*this.zoom,5*this.zoom)
      :new THREE.Vector3(1.4*this.zoom,2.4*this.zoom,5.4*this.zoom));
    camera.position.lerp(this.cameraPosition,1-Math.exp(-dt*8));
    camera.position.y=Math.max(camera.position.y,demoTerrain.sample(camera.position.x,camera.position.z)+0.65);
    if(this.group.visible) {
      this.cameraOffset.copy(camera.position).sub(this.cameraTarget);
      const length=this.cameraOffset.length();
      this.cameraRay.set(this.cameraTarget,this.cameraOffset.normalize());
      let nearest=length;
      for(const box of this.wallBoxes) {
        if(this.cameraRay.intersectBox(box,this.cameraHit)) nearest=Math.min(nearest,this.cameraHit.distanceTo(this.cameraTarget));
      }
      if(nearest<length) camera.position.copy(this.cameraRay.at(Math.max(0.25,nearest-0.25),this.collisionPoint));
    }
    camera.lookAt(this.cameraTarget);
  }

  private removeRing(index:number):void {
    const ring=this.rings.splice(index,1)[0]!;
    ring.mesh.removeFromParent();ring.mesh.geometry.dispose();
    (ring.mesh.material as THREE.Material).dispose();
  }
}
