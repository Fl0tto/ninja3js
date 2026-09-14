import { flatTerrain, type TerrainHeight } from './TerrainHeight';
import { slashDistanceNode } from './SlashShape';
import { roomMaskNode } from './DungeonLayout';
import * as THREE from 'three/webgpu';
import { Fn, If, exp, float, int, instanceIndex, ivec2, max, min, mix, smoothstep, textureLoad, textureStore, uniform, vec2, vec4 } from 'three/tsl';
export type GroundResponseKind = 'sand' | 'snow' | 'grass';
type Node = any;
/** R height offset in metres; G compression; BA bend in metres. No advection.
 * Contact slots: player 0, objects 1..4, blasts 5..9, obstacles 10..13. */
export class GroundResponseField {
  readonly fields: [THREE.StorageTexture, THREE.StorageTexture];
  private index = 0;
  private readonly dt = uniform(1/60);
  private readonly shift = uniform(new THREE.Vector2());
  private readonly worldCenter = uniform(new THREE.Vector2());
  private readonly roomEnabled = uniform(0);
  private readonly wind = uniform(new THREE.Vector2());
  private readonly stamps = Array.from({length:15}, () => uniform(new THREE.Vector4(0,0,1,0)));
  private readonly velocities = Array.from({length:15}, () => uniform(new THREE.Vector2()));
  private readonly slashes = Array.from({length:5}, () => uniform(new THREE.Vector4(0,-1,0.3,0)));
  private readonly deposits = Array.from({length:5}, () => uniform(new THREE.Vector4(0,0,1,0)));
  private readonly updates: Node[];
  private readonly scrolls: Node[];
  private readonly sandFlux?: THREE.StorageTexture;
  private readonly fluxPasses: Node[] = [];
  dispatches = 0;
  constructor(private readonly renderer: THREE.WebGPURenderer, readonly options: {kind: GroundResponseKind; resolution:number; width:number; depth:number; terrain?:TerrainHeight}) {
    this.fields = [this.makeField(), this.makeField()];
    if (options.kind === 'sand') {
      this.sandFlux = this.makeField();
      this.sandFlux.name = 'Sand outgoing east west north south transfers';
      this.fluxPasses = this.fields.map(field => this.buildSandFlux(field));
    }
    this.updates = this.fields.map((r,i) => this.build(r,this.fields[1-i]!,false));
    this.scrolls = this.fields.map((r,i) => this.build(r,this.fields[1-i]!,true));
  }
  get currentIndex():number {return this.index;}
  scroll(cells:THREE.Vector2):void {this.shift.value.add(cells);}
  setWorldCenter(center:THREE.Vector2):void {this.worldCenter.value.copy(center);}
  setRoomEnabled(enabled:boolean):void {this.roomEnabled.value=enabled?1:0;}
  private roomMask(world:Node):Node {return mix(float(1),roomMaskNode(world),this.roomEnabled);}
  setWind(v:THREE.Vector2):void {this.wind.value.copy(v);}
  setStamp(i:number, uv:THREE.Vector2, radius:number, strength:number, v=new THREE.Vector2()):void {
    if (!this.stamps[i]) throw new Error('Invalid ground stamp');
    this.stamps[i]!.value.set(uv.x,uv.y,Math.max(radius,0.001),Math.max(strength,0));
    this.velocities[i]!.value.copy(v).clampLength(0,8);
    if (i >= 5 && i < 10) this.slashes[i-5]!.value.w = 0;
  }
  setSlashStamp(i: number, uv: THREE.Vector2, halfLength: number, width: number, forward: THREE.Vector2, strength: number): void {
    this.setStamp(i,uv,halfLength/Math.min(this.options.width,this.options.depth),strength);
    this.slashes[i-5]!.value.set(forward.x,forward.y,width,1);
  }
  clearStamp(i:number):void {this.stamps[i]!.value.w=0;}
  setDeposit(i:number,uv:THREE.Vector2,radius:number,amount:number):void {
    this.deposits[i]!.value.set(uv.x,uv.y,Math.max(radius,0.001),Math.max(amount,0));
  }
  clearDeposit(i:number):void {this.deposits[i]!.value.w=0;}
  update(seconds:number,active:boolean):void {
    this.dispatches=0;
    if(this.shift.value.lengthSq()) {
      this.renderer.compute(this.scrolls[this.index]); this.index=1-this.index;
      this.shift.value.set(0,0); this.dispatches++;
    }
    if(!active)return;
    this.dt.value=Math.min(Math.max(seconds,0),1/30);
    if (this.sandFlux) {
      this.renderer.compute(this.fluxPasses[this.index]);
      this.dispatches++;
    }
    this.renderer.compute(this.updates[this.index]);this.index=1-this.index;this.dispatches++;
  }
  dispose():void {this.fields.forEach(f=>f.dispose());this.sandFlux?.dispose();}
  private makeField():THREE.StorageTexture {
    const f=new THREE.StorageTexture(this.options.resolution,this.options.resolution);
    f.name=this.options.kind+' independent response';f.type=this.options.kind === 'sand' ? THREE.FloatType : THREE.HalfFloatType;
    f.format=THREE.RGBAFormat;f.minFilter=f.magFilter=THREE.NearestFilter;f.generateMipmaps=false;return f;
  }
  private build(read:THREE.StorageTexture,write:THREE.StorageTexture,scrollOnly:boolean):Node {
    const {resolution:n,width,depth,kind}=this.options;
    return Fn(()=>{
      const x=int(instanceIndex.mod(n)),y=int(instanceIndex.div(n)),cell=ivec2(x,y);
      const allowed=this.roomMask(vec2(float(x).add(0.5),float(y).add(0.5)).div(n).sub(0.5).mul(vec2(width,depth)).add(this.worldCenter));
      if(scrollOnly) {
        const src:Node=cell.add(ivec2(this.shift)),result=vec4(0).toVar();
        If(src.x.greaterThanEqual(0).and(src.y.greaterThanEqual(0)).and(src.x.lessThan(n)).and(src.y.lessThan(n)),()=>{
          result.assign(textureLoad(read,src.clamp(0,n-1)));
        });
        textureStore(write,cell,result.mul(allowed)).toWriteOnly();return;
      }
      const prev=textureLoad(read,cell);
      const fieldUv=vec2(float(x).add(0.5),float(y).add(0.5)).div(n);
      const contact=float(0).toVar(),rim=float(0).toVar(),force=vec2(0).toVar();
      for(let i=0;i<15;i++) {
        const s=this.stamps[i]!,offset=fieldUv.sub(s.xy).mul(vec2(width,depth));
        const slash = i>=5 && i<10 ? this.slashes[i-5]! : null;
        const radial=slash ? slash.w.greaterThan(0).select(
          slashDistanceNode(offset,slash.xy,s.z.mul(Math.min(width,depth)),slash.z),
          offset.length().div(s.z.mul(Math.min(width,depth)))) : offset.length().div(s.z.mul(Math.min(width,depth)));
        const core=float(1).sub(smoothstep(0,1,radial)).mul(s.w).clamp(0,1);
        contact.assign(max(contact,core));
        rim.assign(max(rim,float(1).sub(smoothstep(0,0.3,radial.sub(1.05).abs())).mul(s.w).mul(0.025)));
        const direction=slash ? slash.w.greaterThan(0).select(slash.xy,offset.div(offset.length().max(0.001))).mul(s.w):this.velocities[i]!;
        force.addAssign(direction.mul(core));
      }
      const deposit=float(0).toVar();
      for(const s of this.deposits) deposit.addAssign(float(1).sub(smoothstep(0,s.z,fieldUv.sub(s.xy).length())).mul(s.w).mul(0.025));
      if(kind==='grass') {
        const target=this.wind.mul(0.18).add(force.mul(0.15)).clamp(-0.55,0.55);
        const bend=mix(prev.ba,target,float(1).sub(exp(this.dt.mul(-5))));
        textureStore(write,cell,vec4(0,max(prev.g.mul(exp(this.dt.mul(-0.8))),contact),bend).mul(allowed)).toWriteOnly();
      } else {
        const height=prev.r.toVar();
        if(kind==='sand') {
          const flux = textureLoad(this.sandFlux!, cell);
          height.subAssign(flux.r.add(flux.g).add(flux.b).add(flux.a));
          const directions = [[-1,0,'r'],[1,0,'g'],[0,-1,'b'],[0,1,'a']] as const;
          for (const [dx,dy,channel] of directions) {
            const sx: Node = x.add(dx), sy: Node = y.add(dy);
            If(sx.greaterThanEqual(0).and(sx.lessThan(n)).and(sy.greaterThanEqual(0)).and(sy.lessThan(n)), () => {
              height.addAssign((textureLoad(this.sandFlux!, ivec2(sx.clamp(0,n-1),sy.clamp(0,n-1))) as Node)[channel]);
            });
          }
          // Deposits are the only source. Every other change is a transfer;
          // do not clamp height afterward, which would silently lose mass.
          height.addAssign(deposit.mul(this.dt));
          textureStore(write,cell,vec4(height,max(prev.g.mul(exp(this.dt.mul(-0.08))),contact),0,0).mul(allowed)).toWriteOnly();
          return;
        }
        const rate=float(1).sub(exp(this.dt.mul(-24)));
        If(contact.greaterThan(0.001),()=>height.assign(mix(height,min(height,contact.mul(-0.10)),rate)));
        // Contact rims are an artistic approximation, not mass-conserving excavation.
        If(rim.greaterThan(0.0001).and(contact.lessThan(0.05)),()=>height.assign(mix(height,max(height,rim),rate)));
        height.addAssign(deposit.mul(this.dt));
        // Fresh accumulation covers the packed shading as it fills an imprint.
        // Height persists after contact; only the optical compression recovers.
        const compression = max(prev.g.mul(exp(this.dt.mul(-0.008)))
          .mul(exp(deposit.mul(this.dt).mul(-80))), contact);
        textureStore(write,cell,vec4(height.clamp(-0.12,0.45),compression,0,0).mul(allowed)).toWriteOnly();
      }
    })().compute(n*n).setName(kind+(scrollOnly?' scroll':' response'));
  }

  /** Outgoing transfers are budgeted once per donor cell, then gathered by
   * neighbours. Closed edges and a 12 cm mobile layer bound excavation. */
  private buildSandFlux(read: THREE.StorageTexture): Node {
    const {resolution:n,width,depth} = this.options;
    const pressure = (fieldUv: Node): Node => {
      const result = float(0).toVar();
      for (let i=0;i<this.stamps.length;i++) {
        const stamp=this.stamps[i]!;
        const radius = stamp.z.mul(Math.min(width,depth));
        const distance = fieldUv.sub(stamp.xy).mul(vec2(width,depth)).length();
        const slash=i>=5&&i<10?this.slashes[i-5]!:null;
        const metric=slash?slash.w.greaterThan(0).select(slashDistanceNode(fieldUv.sub(stamp.xy).mul(vec2(width,depth)),slash.xy,radius,slash.z),distance.div(radius)):distance.div(radius);
        const core = float(1).sub(smoothstep(0,1,metric));
        result.assign(max(result,core.mul(stamp.w).mul(0.25)));
      }
      return result;
    };
    return Fn(() => {
      const x=int(instanceIndex.mod(n)),y=int(instanceIndex.div(n)),cell=ivec2(x,y);
      const fieldUv=vec2(float(x).add(0.5),float(y).add(0.5)).div(n);
      const height=textureLoad(read,cell).r;
      const terrain = this.options.terrain ?? flatTerrain;
      const world = fieldUv.sub(0.5).mul(vec2(width,depth)).add(this.worldCenter);
      const base = terrain.node(world);
      const load=pressure(fieldUv);
      const flux=vec4(0).toVar();
      const windSpeed=this.wind.length();
      // Entrainment threshold: ordinary light wind leaves settled sand alone.
      const shear=this.wind.div(windSpeed.max(0.001)).mul(windSpeed.sub(0.25).max(0)).mul(0.025);
      const directions=[[1,0,'r'],[-1,0,'g'],[0,1,'b'],[0,-1,'a']] as const;
      for(const [dx,dy,channel] of directions) {
        const sx:Node=x.add(dx),sy:Node=y.add(dy);
        If(sx.greaterThanEqual(0).and(sx.lessThan(n)).and(sy.greaterThanEqual(0)).and(sy.lessThan(n)),()=>{
          const neighbor=textureLoad(read,ivec2(sx.clamp(0,n-1),sy.clamp(0,n-1))).r;
          const neighborLoad=pressure(fieldUv.add(vec2(dx/n,dy/n)));
          const cellSize=(dx?width:depth)/n;
          // Contacts raise transport potential, driving grains out of their
          // footprint. Unloaded terrain resists slopes below tan(32 degrees).
          const repose=float(1).sub(load.max(neighborLoad).div(0.05).clamp(0,1)).mul(cellSize*0.62);
          const potential=height.add(base).sub(neighbor.add(terrain.node(world.add(vec2(dx*width/n,dy*depth/n))))).add(load.sub(neighborLoad));
          const windTransfer=shear.dot(vec2(dx,dy)).max(0);
          const open=this.roomMask(world).mul(this.roomMask(world.add(vec2(dx*width/n,dy*depth/n))));
          (flux as Node)[channel].assign(potential.sub(repose).max(0).mul(6).add(windTransfer).mul(this.dt).mul(open));
        });
      }
      const total=flux.r.add(flux.g).add(flux.b).add(flux.a);
      const available=height.add(0.12).max(0);
      flux.mulAssign(available.div(total.max(0.0000001)).min(1));
      textureStore(this.sandFlux!,cell,flux).toWriteOnly();
    })().compute(n*n).setName('Sand conservative outgoing transport');
  }
}
