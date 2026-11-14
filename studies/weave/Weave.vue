<script setup lang="ts">
import {computed,ref,onMounted,onBeforeUnmount,watchEffect} from 'vue'
import Room from '../../src/screens/Room.vue'
import Switchback from '../../src/components/Switchback.vue'
import {call} from '../../src/call'
import {colors,names,turns} from './scene'
const mode=ref(0), t=ref(29), playing=ref(false), ready=ref(false),focus=ref(-1)
call.selfId='Pi';call.status='connected';call.members=names.map((name,i)=>({id:name,name,joinedAt:i+1,away:false,muted:false,deafened:false}))
watchEffect(()=>{call.speaking=new Set(turns.filter(b=>b.start<=t.value&&t.value<b.end).map(b=>names[b.voice]!))})
const tokens=computed(()=>turns.flatMap(b=>b.words).filter(w=>w.arrives<=t.value).sort((a,b)=>a.start-b.start||a.id-b.id||a.index-b.index))
const blocks=computed(()=>{
 const groups:(typeof tokens.value)[]=[];let end=-Infinity
 for(const w of tokens.value){if(w.start-end>=1.1)groups.push([]);groups.at(-1)!.push(w);end=Math.max(end,w.end)}
 return groups
})
const rows=computed(()=>{
 let end=-Infinity,root=0
 return turns.map(b=>{const overlap=b.start<end;if(!overlap)root=b.id;end=Math.max(end,b.end)
 return {id:b.id,overlapRoot:overlap?root:null,name:names[b.voice]!,color:colors[b.voice]!,text:b.words.filter(w=>w.arrives<=t.value).map(w=>w.text).join(' ')}
 }).filter(b=>b.text)
})
let timer=0
onMounted(()=>{ready.value=true;let prev=performance.now();timer=window.setInterval(()=>{const now=performance.now();if(playing.value){t.value=Math.min(29,t.value+(now-prev)/1000);if(t.value>=29)playing.value=false}prev=now},60)})
onBeforeUnmount(()=>clearInterval(timer))
</script>
<template><Room/><Teleport v-if="ready" to="main.stage"><section class="reader"><header><button v-for="(name,i) in ['Switchback','Word weave']" :aria-pressed="mode===i" @click="mode=i">{{name}}</button></header><main><div class="page"><div class="roster"><button v-for="(name,i) in names" :style="{color:colors[i]}" :disabled="mode===0" :aria-pressed="focus===i" @click="focus=focus===i?-1:i">{{name}}</button></div><Switchback v-if="mode===0" :messages="rows"/><div v-else class="weave"><p v-for="group in blocks" :key="group[0]?.start"><span v-for="w in group" :key="w.id+'-'+w.index" :title="names[w.voice]+' · '+w.start.toFixed(2)+' s'" :style="{color:colors[w.voice],opacity:focus===-1||focus===w.voice?1:.35}">{{w.text + ' '}}</span></p></div></div></main><footer><button @click="t=0;playing=true">Replay</button><button @click="t>=29&&(t=0);playing=!playing">{{playing?'Pause':'Play'}}</button><input aria-label="Call position" v-model.number="t" type="range" min="0" max="29" step=".05"><time>{{t.toFixed(1)}} s</time></footer></section></Teleport></template>
<style scoped>
.reader{position:absolute;inset:0 0 80px;background:var(--bg-stage);display:flex;flex-direction:column}.reader header,.reader footer,.page{width:min(94%,760px);margin:0 auto}.reader header,.reader footer,.roster{display:flex;align-items:center;gap:7px;padding:10px 0}.reader header{border-bottom:1px solid var(--border-subtle)}button{font:inherit;font-size:13px;background:var(--bg-secondary-alt);color:var(--header-primary);border:1px solid var(--border-strong);border-radius:5px;padding:4px 9px}button[aria-pressed=true]{background:var(--bg-primary);border-color:var(--brand-soft)}main{overflow:auto;flex:1}.roster button{background:none;border-color:transparent;font-weight:600}.roster button[aria-pressed=true]{text-decoration:underline}.weave{padding:0 12px;font:inherit;font-size:15px;line-height:1.54}.weave p{margin:3px 0 15px}.reader footer{justify-content:center}.reader input{width:140px;accent-color:var(--brand-soft)}time{font:12px var(--font-code);color:var(--text-muted)}
</style>
