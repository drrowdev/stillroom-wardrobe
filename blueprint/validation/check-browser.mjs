// Contract prototype only: Chromium canvas/EXIF and Mermaid parsing, not an app test.
// PLAYWRIGHT_MODULE may point to an installed Playwright package index.mjs.
// MERMAID_DIST must point to Mermaid's dist directory. Pass fixture directory as argv[2].
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
const modulePath=process.env.PLAYWRIGHT_MODULE;
const {chromium}=await import(modulePath?pathToFileURL(modulePath).href:'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const dist=path.resolve(process.env.MERMAID_DIST);
const fixtureDir=path.resolve(process.argv[2]);
const fixtures=JSON.parse(await fs.readFile(path.join(fixtureDir,'fixtures.json'),'utf8'));
const diagrams=[];
for(const name of (await fs.readdir(root)).filter(x=>x.endsWith('.md'))){
 const body=await fs.readFile(path.join(root,name),'utf8');
 for(const m of body.matchAll(/```mermaid\s*\n([\s\S]*?)```/g))diagrams.push({file:name,source:m[1]});
}
const server=http.createServer(async(req,res)=>{
 try{
  if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Contract verification</title>');return;}
  const target=path.resolve(dist,decodeURIComponent(req.url.slice(1)));
  if(!target.startsWith(dist+path.sep)){res.writeHead(403);res.end();return;}
  const data=await fs.readFile(target);
  res.writeHead(200,{'Content-Type':target.endsWith('.mjs')||target.endsWith('.js')?'text/javascript':'application/octet-stream'});res.end(data);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let executablePath=process.env.CHROMIUM_EXECUTABLE||chromium.executablePath(),args=[];
if(process.env.CHROMIUM_PACKAGE){
 const {default:binary}=await import(pathToFileURL(process.env.CHROMIUM_PACKAGE).href);
 executablePath=process.env.CHROMIUM_EXECUTABLE||await binary.executablePath();
 args=binary.args.filter(arg=>!['--disable-web-security','--allow-running-insecure-content'].includes(arg));
}
const browser=await chromium.launch({headless:true,executablePath,args});
const checks=[];
try{
 const page=await browser.newPage();
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 for(const diagram of diagrams){
  await page.evaluate(async({source})=>{
   const {default:mermaid}=await import('/mermaid.esm.min.mjs');
   mermaid.initialize({startOnLoad:false,securityLevel:'strict'});
   await mermaid.parse(source);
  },diagram);
  checks.push({name:`Mermaid syntax: ${diagram.file}`,result:'PASS'});
 }
 function assertNoMetadata(data){
  const bytes=Buffer.from(data);
  assert.equal(bytes.readUInt16BE(0),0xffd8);
  let at=2;
  while(at+4<=bytes.length){
   assert.equal(bytes[at],0xff);
   const marker=bytes[at+1];
   if(marker===0xda||marker===0xd9)break;
   const length=bytes.readUInt16BE(at+2);
   assert.ok(length>=2);
   // EXIF/XMP use APP1, IPTC uses APP13. JFIF APP0 is harmless encoder metadata.
   assert.ok(marker!==0xe1&&marker!==0xed,'Encoded JPEG retained private metadata segment');
   at+=2+length;
  }
 }
 for(const fixture of fixtures){
  const input=await fs.readFile(path.join(fixtureDir,fixture.name));
  if(fixture.metadata){assert.ok(input.includes(Buffer.from('Exif\0\0')));assert.ok(input.includes(Buffer.from('xap/1.0')));}
  const output=await page.evaluate(async({base64,mime})=>{
   const input=new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:mime});
   const image=await createImageBitmap(input,{imageOrientation:'from-image'});
   const original=[image.width,image.height];
   async function encode(source,maxSide,limit,minSide){
    let side=Math.min(maxSide,Math.max(source.width,source.height));
    while(true){
     const ratio=side/Math.max(source.width,source.height);
     const canvas=document.createElement('canvas');
     canvas.width=Math.max(1,Math.round(source.width*ratio));canvas.height=Math.max(1,Math.round(source.height*ratio));
     const ctx=canvas.getContext('2d');ctx.fillStyle='#F6F3ED';ctx.fillRect(0,0,canvas.width,canvas.height);
     ctx.drawImage(source,0,0,canvas.width,canvas.height);
     for(const quality of [0.82,0.75,0.68,0.61,0.55]){
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
      if(blob.size<=limit){
       const decoded=await createImageBitmap(blob);
       ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(decoded,0,0);decoded.close();
       const colours=[[0.1,0.1],[0.9,0.1],[0.1,0.9],[0.9,0.9]].map(([x,y])=>Array.from(ctx.getImageData(Math.floor(x*canvas.width),Math.floor(y*canvas.height),1,1).data).slice(0,3));
       return {blob,canvas,colours,quality};
      }
     }
     canvas.width=canvas.height=1;
     if(side<=minSide)throw new Error('Byte budget cannot be met');
     side=Math.max(minSide,Math.floor(side*0.85));
    }
   }
   const main=await encode(image,1600,500*1024,800);image.close();
   const thumb=await encode(main.canvas,320,60*1024,160);
   const result={original,main:{width:main.canvas.width,height:main.canvas.height,quality:main.quality,colours:main.colours,bytes:Array.from(new Uint8Array(await main.blob.arrayBuffer()))},
    thumb:{width:thumb.canvas.width,height:thumb.canvas.height,bytes:Array.from(new Uint8Array(await thumb.blob.arrayBuffer()))}};
   main.canvas.width=main.canvas.height=thumb.canvas.width=thumb.canvas.height=1;
   return result;
  },{base64:input.toString('base64'),mime:fixture.mime});
  assert.deepEqual(output.original,fixture.expectedSize,`${fixture.name}: orientation dimensions`);
  assert.ok(Math.max(output.main.width,output.main.height)<=1600);
  assert.ok(Math.max(output.main.width,output.main.height)<=Math.max(...fixture.expectedSize));
  if(fixture.mustReduceDimensions)assert.ok(Math.max(output.main.width,output.main.height)<1600,'Dense input must exercise dimension reduction');
  assert.ok(Math.max(output.thumb.width,output.thumb.height)<=320);
  assert.ok(output.main.bytes.length<=500*1024);assert.ok(output.thumb.bytes.length<=60*1024);
  assertNoMetadata(output.main.bytes);assertNoMetadata(output.thumb.bytes);
  if(fixture.corners)fixture.corners.forEach((colour,i)=>colour.forEach((component,j)=>assert.ok(Math.abs(component-output.main.colours[i][j])<18,`${fixture.name}: orientation corner ${i}`)));
  checks.push({name:`Canvas contract: ${fixture.name}`,result:'PASS',mainBytes:output.main.bytes.length,thumbBytes:output.thumb.bytes.length,mainSize:[output.main.width,output.main.height],quality:output.main.quality});
 }
 console.log(JSON.stringify({browser:`Chromium ${browser.version()}`,scope:'Prototype contracts; no production app or physical phone tested',checks},null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
