<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'
import Room from '../../src/screens/Room.vue'
import Avatar from '../../src/components/Avatar.vue'
import { call } from '../../src/call'
import { cast, turns } from '../counterpoint/exchange'

const variants=['Margin','Switchback','Confluence']
const mode=ref(0), time=ref(9.1), running=ref(false), ready=ref(false)
const board=ref<HTMLElement>()
const paths=ref<{d:string;color:string}[]>([])
const scene=turns.map((b,i)=>i===3?{...b,stop:6.7,revisions:[[7.7,'Oh.']] as [number,string][]}:b)
const active=(v:number)=>scene.some(b=>b.voice===v&&time.value>=b.start&&time.value<b.stop)
const words=computed(()=>scene.map(b=>b.revisions.filter(([t])=>t<=time.value).at(-1)?.[1]||''))
const history=computed(()=>scene.map((b,i)=>({...b,i,text:words.value[i]})).filter(b=>b.text))
type Line=(typeof history.value)[number]
const groups=computed(()=>{
 const result:{end:number;list:Line[]}[]=[]
 for(const line of history.value){
  const group=result.at(-1)
  if(group && line.start<group.end){group.list.push(line);group.end=Math.max(group.end,line.stop)}
  else result.push({end:line.stop,list:[line]})
 }
 for (const g of result) {
  const [first, ...rest] = g.list
  if (first) g.list = [first, ...rest.sort((a,b)=>a.revisions[0]![0]-b.revisions[0]![0])]
 }
 return result
})
call.selfId='Pi';call.status='connected'
call.members=cast.map(({name},i)=>({id:name,name,joinedAt:i+1,away:false,muted:false,deafened:false}))
watchEffect(()=>{call.speaking=new Set(cast.filter((_,i)=>active(i)).map(p=>p.name))})
function redraw(){
 const root=board.value
 if(!root)return
 const base=root.getBoundingClientRect()
 const point=(el:Element)=>{const r=el.getBoundingClientRect();return {x:r.x-base.x+r.width/2,y:r.y-base.y+r.height/2}}
 const curves:{d:string;color:string}[]=[]
 for(const group of root.querySelectorAll('.exchange')){
  const dots=Array.from(group.querySelectorAll('.pin'))
  if(dots.length<2)continue
  const a=point(dots[0]!)
  for(const dot of dots.slice(1)){
   const b=point(dot), bend=mode.value===1?23:16
   const d=mode.value===2?'M '+a.x+' '+a.y+' C '+a.x+' '+(a.y+28)+' '+b.x+' '+(b.y-28)+' '+b.x+' '+b.y:
   'M '+a.x+' '+a.y+' V '+(b.y-bend)+' Q '+a.x+' '+b.y+' '+(a.x+bend)+' '+b.y+' H '+b.x
   curves.push({d,color:getComputedStyle(dot).backgroundColor})
  }
 }
 paths.value=curves
}
let timer=0,observer:ResizeObserver|undefined
onMounted(async()=>{ready.value=true;await nextTick();observer=new ResizeObserver(redraw);if(board.value)observer.observe(board.value);let last=performance.now();timer=window.setInterval(()=>{const now=performance.now();if(running.value){time.value=Math.min(14,time.value+(now-last)/1000);if(time.value>=14)running.value=false}last=now},50)})
watch([words,mode],redraw,{flush:'post'})
onBeforeUnmount(()=>{observer?.disconnect();clearInterval(timer)})
function play(){if(time.value>=14)time.value=0;running.value=!running.value}
</script>
<template><Room/><Teleport v-if="ready" to="main.stage"><section class="paper" :class="'v'+mode">
<header><div class="people"><span v-for="(p,i) in cast" :class="{on:active(i)}" :style="{'--ink':p.ink}"><Avatar :name="p.name" :hue="p.hue" :size="22"/>{{p.name}}</span></div><select aria-label="Prototype" v-model="mode"><option v-for="(v,i) in variants" :value="i">{{v}}</option></select></header>
<div class="scroll"><div class="board" ref="board"><svg aria-hidden="true"><path v-for="p in paths" :d="p.d" :stroke="p.color"/></svg>
<div class="exchange" v-for="g in groups" :key="g.list[0]?.i" :class="{poly:g.list.length>1,solo:g.list.length===1}">
<article v-for="(l,n) in g.list" :key="l.i" :class="n?'branch':'stem'" :style="{'--ink':cast[l.voice]?.ink}"><i class="pin"/><div><b>{{cast[l.voice]?.name}}</b><p>{{l.text}}</p></div></article>
</div></div></div><footer><button @click="time=0;running=true">Replay</button><button @click="play">{{running?'Pause':'Play'}}</button><input aria-label="Call position" v-model.number="time" type="range" min="0" max="14" step=".05"><time>{{time.toFixed(1)}} s</time></footer></section></Teleport></template>
<style scoped>
.paper{position:absolute;inset:0 0 82px;background:var(--bg-stage);color:var(--header-primary);display:flex;flex-direction:column}.paper header,.paper footer{width:min(92%,920px);margin:auto;display:flex;align-items:center;gap:10px;padding:10px 0}.paper header{justify-content:space-between;border-bottom:1px solid var(--border-subtle)}.people,.people span{display:flex;align-items:center;gap:6px}.people{gap:14px}.people span{font-size:12px}.on .avatar{outline:2px solid var(--ink);outline-offset:2px}button,select{border:1px solid var(--border-strong);border-radius:6px;padding:5px 10px;background:var(--bg-secondary-alt);color:var(--header-primary)}.scroll{flex:1;min-height:0;overflow:auto;display:flex}.board{position:relative;width:min(88%,790px);margin:0 auto auto;padding:clamp(12px,6vh,54px) 0 16px}.board svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;fill:none;stroke-width:1.6}.exchange{position:relative;margin:16px 0}.exchange article{position:relative;display:flex;align-items:baseline;gap:12px}.pin{flex:none;width:8px;height:8px;background:var(--ink);border-radius:100%;align-self:flex-start;margin-top:7px}.paper b{font-size:13px;color:var(--ink)}p{margin:3px 0 0;font-size:clamp(21px,2.8vw,35px);line-height:1.16;letter-spacing:-.04em}.solo p{font-size:20px;color:var(--header-secondary)}.poly{padding:10px 0}.v0 .poly{display:grid;grid-template-columns:1.3fr 1fr;column-gap:7%}.v0 .stem{grid-row:1/4}.v0 .branch{grid-column:2;margin-top:18px}.v0 .branch p{font-size:23px}.v0 .stem p{background:var(--bg-stage);position:relative}.v0 .branch:first-of-type{margin-top:0}.v0 .poly .stem .pin{position:absolute;right:-10px;top:0}.v0 .poly .stem{padding-right:12px}.v0 .poly .stem p{background:none}.v1 .branch{margin:12px 0 0 12%}.v1 .branch:nth-child(3){margin-left:24%}.v1 .exchange p{display:inline;margin-left:12px}.v1 .branch p{font-size:25px}.v1 .stem{padding-bottom:9px}.v2 .poly{display:grid;grid-template-columns:1fr 1fr;column-gap:6%}.v2 .stem{grid-column:1/3;justify-self:center;text-align:center;max-width:80%;flex-direction:column-reverse;align-items:center;gap:0}.v2 .stem .pin{align-self:center}.v2 .branch{margin-top:35px;flex-direction:column;align-items:center;gap:4px;text-align:center}.v2 .branch .pin{align-self:center}.v2 .solo{margin-left:12%}.paper footer{justify-content:center}.paper input{width:130px;accent-color:var(--brand-soft)}time{font:12px var(--font-code);color:var(--text-muted)}
@media(max-width:550px){.board{width:94%}.people{gap:6px}.paper header{width:96%}.v0 .poly{column-gap:4%;grid-template-columns:1fr 1fr}.v0 .branch p,.v1 .branch p{font-size:19px}.exchange article{gap:7px}.v2 .branch{margin-top:15px}}
</style>
