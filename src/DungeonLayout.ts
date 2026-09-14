import { float } from 'three/tsl';

export const ROOM = {left:-5.8,right:5.8,back:-6,front:4.4,doorHalfWidth:1.2,entryEnd:7.5};
export function roomContains(x:number,z:number,inset=0):boolean {
  return x>=ROOM.left+inset && x<=ROOM.right-inset && z>=ROOM.back+inset && z<=ROOM.front-inset;
}
/** The training-room threshold contains effects; the entry remains navigable. */
export function roomMaskNode(at:any) {
  return float(at.x.greaterThanEqual(ROOM.left).and(at.x.lessThanEqual(ROOM.right))
    .and(at.y.greaterThanEqual(ROOM.back)).and(at.y.lessThanEqual(ROOM.front)).select(1,0));
}
function walkable(x:number,z:number):boolean {
  return roomContains(x,z) || (Math.abs(x)<=ROOM.doorHalfWidth && z>=ROOM.front && z<=ROOM.entryEnd);
}
export function canStand(x:number,z:number,radius=0.26):boolean {
  for(let i=0;i<8;i++) if(!walkable(x+Math.cos(i*Math.PI/4)*radius,z+Math.sin(i*Math.PI/4)*radius)) return false;
  return true;
}
/** Short substeps prevent tunnelling and separate axes allow sliding along walls. */
export function moveInDungeon(x:number,z:number,dx:number,dz:number):{x:number;z:number} {
  const count=Math.max(1,Math.ceil(Math.hypot(dx,dz)/0.08));
  for(let i=0;i<count;i++) {
    if(canStand(x+dx/count,z)) x+=dx/count;
    if(canStand(x,z+dz/count)) z+=dz/count;
  }
  return {x,z};
}

// Wall interiors coincide with the simulation bounds. South wall has a doorway.
export const ROOM_WALLS = [
  {x:-6.05,z:-0.8,width:0.5,depth:10.9},
  {x:6.05,z:-0.8,width:0.5,depth:10.9},
  {x:0,z:-6.25,width:12.6,depth:0.5},
  {x:-3.5,z:4.65,width:4.6,depth:0.5},
  {x:3.5,z:4.65,width:4.6,depth:0.5},
  {x:-1.45,z:6.2,width:0.5,depth:3.1},
  {x:1.45,z:6.2,width:0.5,depth:3.1},
];
