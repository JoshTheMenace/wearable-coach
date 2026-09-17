import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type PlacementReference = { pose:'correct'|'too_low'; bytes:Buffer; sha256:string };
export type PlacementReferences = readonly [PlacementReference,PlacementReference];

export function loadPlacementReferences(directory:string):PlacementReferences|undefined {
  if(!existsSync(directory))return;
  const read=(pose:PlacementReference['pose'],file:string):PlacementReference=>{
    const path=join(directory,file),stat=statSync(path);
    if(!stat.isFile()||stat.size<4||stat.size>256*1024)throw new Error('Placement reference must be a JPEG of at most 256 KiB');
    const bytes=readFileSync(path);
    if(bytes.length!==stat.size||bytes.readUInt16BE(0)!==0xffd8||bytes[2]!==0xff||bytes.readUInt16BE(bytes.length-2)!==0xffd9)
      throw new Error('Placement reference has an invalid JPEG signature');
    return {pose,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
  };
  return [read('correct','correct.jpg'),read('too_low','too-low.jpg')];
}
