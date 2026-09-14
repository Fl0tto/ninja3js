import * as THREE from 'three/webgpu';
import { GroundResponseField } from '../src/GroundResponseField';
import { slashDistance, slashProfile } from '../src/SlashShape';
import { EncounterScene } from '../src/EncounterScene';

export async function validateSlashes() {
  const assert = (ok: boolean, message: string) => {if (!ok) throw new Error(message);};
  const renderer = new THREE.WebGPURenderer();
  await renderer.init();
  const results: unknown[] = [];
  try {
    for (const forward of [new THREE.Vector2(0,-1),new THREE.Vector2(1,0)]) {
      for (const kind of ['snow','grass'] as const) {
        const field = new GroundResponseField(renderer,{kind,resolution:64,width:14,depth:14});
        try {
          field.setSlashStamp(5,new THREE.Vector2(0.5,0.5),3,0.4,forward,1.7);
          for (let i=0;i<30;i++) field.update(1/60,true);
          const bytes = await (renderer.backend as any).copyTextureToBuffer(field.fields[field.currentIndex],0,0,64,64);
          const data = Float32Array.from(new Uint16Array(bytes.buffer ?? bytes,bytes.byteOffset ?? 0,64*64*4),THREE.DataUtils.fromHalfFloat);
          let on=0, off=0, backward=0;
          for (let y=0;y<64;y++) for(let x=0;x<64;x++) {
            const metric=slashDistance((x+0.5)/64*14-7,(y+0.5)/64*14-7,forward.x,forward.y,3,0.4);
            const i=(y*64+x)*4;
            const response=kind==='snow'?Math.max(0,-data[i]!):Math.hypot(data[i+2]!,data[i+3]!);
            if(metric<0.5) on=Math.max(on,response);
            if(metric>1.6) off=Math.max(off,response);
            if(kind==='grass') backward=Math.min(backward,data[i+2]!*forward.x+data[i+3]!*forward.y);
          }
          assert(on>(kind==='snow'?0.06:0.1),'Slash must visibly affect '+kind);
          assert(off<0.0001,'Slash must leave off-stroke '+kind+' untouched');
          assert(backward>=-0.0001,'Grass must bend in the slash direction');
          results.push({kind,forward:forward.toArray(),on,off});
        } finally {field.dispose();}
      }
    }
    const encounter=new EncounterScene(new THREE.Scene(),()=>{},()=>{});
    encounter.controls.remove();
    try {
      const trees=(encounter as any).trees;
      const p=slashProfile(1,3,0.4);
      trees[0].pivot.position.set(1,0,-p.bow);
      trees[1].pivot.position.set(1,0,2);
      trees[2].pivot.position.set(8,0,8);
      encounter.attack({position:new THREE.Vector3(),radius:3,impulse:10,duration:0.42,forward:new THREE.Vector2(0,-1),width:0.4});
      for(let i=0;i<30;i++) encounter.update(1/120);
      assert(trees[0].bend.length()>0,'Tree on the slash must recoil');
      assert(trees[1].bend.length()===0,'Tree beside the slash must not recoil');
    } finally {
      encounter.reset();
      encounter.group.traverse(object=>{const mesh=object as THREE.Mesh;mesh.geometry?.dispose();if(Array.isArray(mesh.material))mesh.material.forEach(m=>m.dispose());else mesh.material?.dispose();});
    }
    return results;
  } finally {renderer.dispose();}
}
