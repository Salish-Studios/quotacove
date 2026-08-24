// QuotaCove — collects per-project, per-model, per-day usage from local
// transcripts into usage.json for the dashboard. Reads model names and token
// counts; prompt text is scored in memory and never written out.
import { readdirSync, statSync, createReadStream, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { analyze } from "../plugin/lib/score.mjs";

const ROOT = join(homedir(), ".claude", "projects");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "usage.json");
const PRICE = { economy:{in:1,out:5}, balanced:{in:3,out:15}, premium:{in:5,out:25} };
const TIER_OF = { haiku:"economy", sonnet:"balanced", opus:"premium" };
const tierOfModel = m => { const s=String(m).toLowerCase();
  if(s.includes("haiku"))return "economy"; if(s.includes("sonnet"))return "balanced";
  if(s.includes("opus")||s.includes("fable")||s.includes("mythos"))return "premium"; return null; };
const cost=(t,k)=>(k.cacheRead*PRICE[t].in*0.1+(k.in+k.cacheWrite)*PRICE[t].in+k.out*PRICE[t].out)/1e6;
const files=[];(function w(d){let e;try{e=readdirSync(d)}catch{return}
  for(const x of e){const p=join(d,x);let s;try{s=statSync(p)}catch{continue}
    if(s.isDirectory())w(p);else if(x.endsWith(".jsonl"))files.push(p)}})(ROOT);

const textOf=c=>typeof c==="string"?c:Array.isArray(c)?c.filter(y=>y?.type==="text").map(y=>y.text??"").join("\n"):"";
const proj={},models={},days={},hours=new Array(24).fill(0);
let turns=0,actual=0,routed=0,tokIn=0,tokCache=0,tokOut=0;

for(const f of files){
  const name=(f.split("/projects/")[1]??"").split("/")[0]||"(unknown)";
  const rl=createInterface({input:createReadStream(f),crlfDelay:Infinity});
  let last=null;
  for await(const line of rl){
    if(!line.trim())continue; let j;try{j=JSON.parse(line)}catch{continue}
    const m=j.message; if(!m)continue;
    if(m.role==="user"){const t=textOf(m.content).trim();
      if(t&&!t.startsWith("/")&&!t.startsWith("<")&&t.length>8)last=t; continue}
    if(m.role!=="assistant"||!m.usage)continue;
    const at=tierOfModel(m.model); if(!at)continue;
    const u=m.usage, k={in:u.input_tokens??0,cacheRead:u.cache_read_input_tokens??0,
      cacheWrite:u.cache_creation_input_tokens??0,out:u.output_tokens??0};
    const want=last?TIER_OF[analyze(last).tier]:at;
    const rank={economy:0,balanced:1,premium:2};
    const fin=rank[want]>rank[at]?at:want;
    const a=cost(at,k), r=cost(fin,k);
    turns++; actual+=a; routed+=r; tokIn+=k.in; tokCache+=k.cacheRead; tokOut+=k.out;
    const key=name.replace(/^-Users-bradd-?/,"")||"home";
    proj[key]??={turns:0,actual:0,routed:0,models:{}};
    proj[key].turns++; proj[key].actual+=a; proj[key].routed+=r;
    proj[key].models[m.model]=(proj[key].models[m.model]??0)+1;
    models[m.model]??={turns:0,actual:0,tier:at};
    models[m.model].turns++; models[m.model].actual+=a;
    const ts=Date.parse(j.timestamp??"");
    if(!Number.isNaN(ts)){const d=new Date(ts).toISOString().slice(0,10);
      days[d]??={turns:0,actual:0,routed:0}; days[d].turns++; days[d].actual+=a; days[d].routed+=r;
      hours[new Date(ts).getHours()]++;}
  }
}
const out={generated:new Date().toISOString(),turns,actual,routed,
  tokens:{in:tokIn,cacheRead:tokCache,out:tokOut},
  projects:Object.entries(proj).map(([n,v])=>({name:n,...v,models:Object.entries(v.models).map(([m,c])=>({m,c})).sort((a,b)=>b.c-a.c)}))
    .sort((a,b)=>b.actual-a.actual),
  models:Object.entries(models).map(([m,v])=>({name:m,...v})).sort((a,b)=>b.actual-a.actual),
  days:Object.entries(days).map(([d,v])=>({d,...v})).sort((a,b)=>a.d<b.d?-1:1),
  hours};
writeFileSync(OUT,JSON.stringify(out));
console.log(`turns=${turns} projects=${out.projects.length} models=${out.models.length} days=${out.days.length} actual=$${actual.toFixed(0)} routed=$${routed.toFixed(0)}`);
console.log("tokens: in="+(tokIn/1e6).toFixed(1)+"M cacheRead="+(tokCache/1e9).toFixed(1)+"B out="+(tokOut/1e6).toFixed(1)+"M");
