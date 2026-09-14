import * as THREE from 'three/webgpu';
import { ROOM, roomContains, canStand, moveInDungeon } from '../src/DungeonLayout';
import { EncounterScene } from '../src/EncounterScene';
import { GroundResponseField } from '../src/GroundResponseField';
import { FluidFire } from '../src/FluidFire';
import { demoTerrain } from '../src/TerrainHeight';

export async function validateDungeon() {
  const assert=(ok:boolean,message:string)=>{if(!ok)throw new Error(message);};
  const wall=moveInDungeon(0,0,30,0);
  assert(wall.x<ROOM.right-0.24 && canStand(wall.x,wall.z),'Movement must not tunnel through wall');
  const doorway=moveInDungeon(0,3,0,3);
  assert(doorway.z>5.9,'Player must pass through doorway');
  const besideDoor=moveInDungeon(3,3,0,3);
  assert(besideDoor.z<ROOM.front,'Player must not walk through wall beside doorway');
  const encounter=new EncounterScene(new THREE.Scene(),()=>{},()=>{});
  encounter.controls.remove();
  const step=(n:number)=>{for(let i=0;i<n;i++)encounter.update(1/120);};
  const strike=(powerful:boolean)=>{
    encounter.powerful=powerful;
    encounter.attack({position:encounter.aimAtEnemy(new THREE.Vector3()),radius:powerful?5.2:2.5,impulse:powerful?10:4,duration:powerful?0.42:0.24,forward:new THREE.Vector2(0,-1),width:powerful?0.48:0.3});
  };
  try {
    const combat=encounter.combat, position=new THREE.Vector3(0,0,0);
    const combatStep=(seconds:number)=>{for(let i=0;i<Math.round(seconds*120);i++)combat.update(1/120,position,encounter.enemy.home,true);};
    combatStep(1.6);assert(combat.phase==='warning','Sentinel must telegraph before impact');
    combatStep(0.9);assert(combat.hits===1,'Standing in warning must take one hit');
    assert(combat.health===75,'One sentinel hit must deal 25 damage');
    combatStep(0.5);assert(combat.hits===1,'Recovery must not repeat damage');
    combat.reset();combatStep(2.2);
    assert(combat.dodge(new THREE.Vector3(1,0,0)),'Ready dodge must activate');
    assert(!combat.dodge(new THREE.Vector3()),'Dodge cooldown must reject repeats');
    combatStep(0.2);assert(combat.hits===0 && combat.dodges===1,'Late dodge must avoid the impact');
    assert(combat.health===100,'Timed dodge must preserve health');
    combat.reset();combatStep(1.6);position.x=3;combatStep(0.9);
    assert(combat.hits===0,'Moving clear of locked target must avoid damage');
    position.x=0;combat.reset();combatStep(1.6);
    combat.update(0.1,position,encounter.enemy.home,false);
    assert(!combat.cue.visible && combat.phase==='ready','Enemy defeat must cancel pending strike');
    combat.reset();combatStep(15);
    assert(combat.defeated && combat.health===0 && combat.hits===4,'Four hits must defeat player exactly once');
    assert(!combat.cue.visible && !combat.dodge(new THREE.Vector3(1,0,0)),'Defeat must cancel warning and reject dodge');
    combatStep(5);assert(combat.hits===4,'Defeated player must not take more hits');
    encounter.setEnabled(false);encounter.setEnabled(true);
    assert(combat.defeated,'Mode switching must not revive the player');
    encounter.controls.querySelector<HTMLButtonElement>('[data-enemy-reset]')!.click();
    assert(combat.defeated,'Reset target must not revive the player');
    encounter.controls.querySelector<HTMLButtonElement>('[data-player-retry]')!.click();
    assert(combat.health===100 && !combat.defeated && combat.hits===0 && encounter.enemy.health===100,'Retry must restore both characters and clear counters');
    combat.reset();
    strike(false);step(60);
    assert(encounter.enemy.health===82 && encounter.enemy.hits===1,'One modest slash must deal exactly 18 damage once');
    encounter.reset();strike(true);step(60);
    assert(encounter.enemy.health===58 && encounter.enemy.hits===1,'One powerful slash must deal exactly 42 damage once');
    strike(true);step(60);strike(true);step(60);
    assert(encounter.enemy.health===0,'Three powerful slashes must defeat target');
    step(400);assert(encounter.enemy.health===100,'Defeated target must reset');
    encounter.attack({position:new THREE.Vector3(7,0,0),radius:20,impulse:10,duration:0.42});step(60);
    assert(encounter.enemy.health===100,'Attack originating beyond wall must be rejected');
    const camera=new THREE.PerspectiveCamera();camera.position.set(3,2,8);
    encounter.cameraMode='dungeon';
    const player=new THREE.Vector3(3,demoTerrain.sample(3,3.4)+0.96,3.4);
    for(let i=0;i<120;i++)encounter.updateCamera(camera,player,1/60);
    assert(!(encounter as any).wallBoxes.some((box:THREE.Box3)=>box.containsPoint(camera.position)),'Camera must remain outside wall solids');
  } finally {
    encounter.reset();encounter.group.traverse(object=>{const mesh=object as THREE.Mesh;mesh.geometry?.dispose();if(Array.isArray(mesh.material))mesh.material.forEach(m=>m.dispose());else mesh.material?.dispose();});
  }
  const renderer=new THREE.WebGPURenderer();await renderer.init();
  const n=64, results:unknown[]=[];
  const read=async(texture:THREE.StorageTexture,full=false)=>{
    const bytes=await (renderer.backend as any).copyTextureToBuffer(texture,0,0,n,n);
    return full?new Float32Array(bytes.buffer??bytes,bytes.byteOffset??0,n*n*4):Float32Array.from(new Uint16Array(bytes.buffer??bytes,bytes.byteOffset??0,n*n*4),THREE.DataUtils.fromHalfFloat);
  };
  const stats=(data:Float32Array,channels=4)=>{
    let outside=0,inside=0,sum=0;
    for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
      const i=(y*n+x)*4,allowed=roomContains((x+0.5)/n*14-7,(y+0.5)/n*14-7);
      if(allowed){for(let c=0;c<channels;c++)inside=Math.max(inside,Math.abs(data[i+c]!));sum+=data[i]!;}
      else for(let c=0;c<channels;c++)outside=Math.max(outside,Math.abs(data[i+c]!));
    }
    return {outside,inside,sum};
  };
  try {
    for(const kind of ['sand','snow','grass'] as const) {
      const field=new GroundResponseField(renderer,{kind,resolution:n,width:14,depth:14});field.setRoomEnabled(true);
      try {
        field.setSlashStamp(5,new THREE.Vector2(4.8/14+0.5,0.5),3,0.6,new THREE.Vector2(0,-1),1.7);
        for(let i=0;i<90;i++)field.update(1/60,true);
        const result=stats(await read(field.fields[field.currentIndex]!,kind==='sand'));
        assert(result.outside===0,kind+' response must remain inside room');
        assert(result.inside>0.001,kind+' test must produce an actual disturbance');
        if(kind==='sand') assert(Math.abs(result.sum)<0.0001,'Sand must conserve mass at closed walls');
        results.push({kind,...result});
      }finally{field.dispose();}
    }
    const flow=new FluidFire(new THREE.Scene(),renderer,{resolution:n,particleCount:100,width:14,height:14});
    try {
      flow.parameters.groundFlow=true;flow.setRoomBounds(true,new THREE.Vector2());
      flow.setGroundStamp(0,new THREE.Vector2(5.6/14+0.5,0.5),0.2,2,new THREE.Vector2(20,0));
      for(let i=0;i<30;i++)flow.update(1/60);
      const result=stats(await read(flow.scalarFields[flow.currentScalarFieldIndex]!),2);
      assert(result.inside>0.01 && result.outside===0,'Fog density must be generated inside and excluded outside walls');
      results.push({kind:'fog',...result});
    }finally{flow.dispose();}
    return {combat:'telegraph, damage, dodge, four-hit defeat, reset isolation and retry passed',movement:'wall/doorway passed',enemy:'damage, one hit, defeat/reset passed',camera:'wall collision passed',gpu:results};
  }finally{renderer.dispose();}
}
