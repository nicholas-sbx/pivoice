<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watchEffect } from 'vue'
import Room from '../src/screens/Room.vue'
import Avatar from '../src/components/Avatar.vue'
import { call } from '../src/call'
const modes = ['Subtitles','Duet','Conversation score','Backchannels','Roundtable']
const people = ['Mira','Theo','Pi']
call.selfId='Pi'
call.code='FERN'
call.status='connected'
call.members=people.map((name,i)=>({id:name,name,joinedAt:i+1,away:false,muted:false,deafened:false}))
// Local observations and recognition events have independent times.
interface Beat { who:string; start:number; end:number; words:[number,string][] }
const beats:Beat[]=[
 {who:'Pi',start:0,end:1.6,words:[[0.6,'Where should we meet?']]},
 {who:'Theo',start:1.9,end:2.4,words:[]},
 {who:'Mira',start:2.8,end:6.8,words:[[3.4,'At the south'],[4.4,'At the south gate.'],[5.2,'At the south gate. Wait—'],[6.6,'At the south gate. Wait—north gate.']]},
 {who:'Pi',start:4.5,end:5.3,words:[[5,'Mm-hm.']]},
 {who:'Theo',start:5.6,end:7.8,words:[[6,'By the old'],[7,'By the old bridge?']]},
 {who:'Mira',start:9.1,end:10.6,words:[[9.9,'Yeah.'],[10.9,'Yeah. Sorry, north gate.']]}
]
const mode=ref(0), clock=ref(7.2), playing=ref(false), mounted=ref(false)
let timer:ReturnType<typeof setInterval>
onMounted(()=>{mounted.value=true;timer=setInterval(()=>{if(playing.value){clock.value=Math.min(12,clock.value+.1);if(clock.value===12)playing.value=false}},100)})
onBeforeUnmount(()=>clearInterval(timer))
const lines=computed(()=>beats.map((b,index)=>({...b,index,text:b.words.filter(([t])=>t<=clock.value).at(-1)?.[1]||''})).filter(b=>b.text))
const active=(name:string)=>beats.some(b=>b.who===name&&b.start<=clock.value&&clock.value<b.end)
watchEffect(()=>{call.speaking=new Set(people.filter(active))})
const latest=(name:string)=>lines.value.filter(l=>l.who===name).at(-1)
const recent=computed(()=>lines.value.filter(l=>clock.value-l.end<2.2))
const overlap=(b:Beat)=>beats.some(o=>o!==b&&o.start<b.end&&o.end>b.start&&o.words.some(([t])=>t<=clock.value))
function replay(){clock.value=0;playing.value=true}
</script>
<template><Room/><Teleport v-if="mounted" to="main.stage"><section class="study" :class="'m'+mode">
<nav><label>Caption study <select v-model="mode"><option v-for="(name,i) in modes" :value="i">{{ name }}</option></select></label><button @click="replay">Replay</button><button @click="playing=!playing">{{ playing?'Pause':'Play' }}</button><input v-model.number="clock" type="range" min="0" max="12" step=".1" aria-label="Call position"><time>{{clock.toFixed(1)}}s</time></nav>
<div v-if="mode===0" class="subtitle"><article v-for="l in recent.filter(l=>clock-l.end<1.65)" :key="l.index"><strong>{{l.who}}</strong> {{l.text}}</article></div>
<div v-if="mode===1" class="duet"><div v-for="who in people" :key="who"><div class="speaker"><Avatar :name="who" :size="42"/><b>{{who}}</b><i v-if="active(who)">Speaking</i></div><template v-for="l in lines.filter(l=>l.who===who)" :key="l.index"><p :class="{old:l!==latest(who)}">{{l.text}}</p></template></div></div>
<div v-if="mode===2" class="score"><div class="ticks"><span v-for="n in 7">{{(n-1)*2}}s</span></div><div v-for="who in people" class="track"><b>{{who}}</b><div class="strip"><span v-for="b in beats.filter(b=>b.who===who&&b.start<=clock)" :style="{left:b.start/12*100+'%',width:(Math.min(clock,b.end)-b.start)/12*100+'%'}"></span></div></div><div class="script"><p v-for="l in lines"><time>{{l.start.toFixed(1)}}s</time><strong>{{l.who}}</strong>{{l.text}}</p></div></div>
<div v-if="mode===3" class="margin"><div v-for="l in lines" :class="{aside:l.end-l.start<1&&overlap(l)}"><small v-if="l.end-l.start<1&&overlap(l)">During {{beats.find(b=>b.start<l.start&&b.end>l.start)?.who}}’s turn</small><b>{{l.who}}</b><p>{{l.text}}</p></div></div>
<div v-if="mode===4" class="floor"><div v-for="who in people" :class="{lit:active(who)}"><Avatar :name="who" :size="46" :mood="active(who)?'talking':'idle'"/><b>{{who}}</b><p>{{latest(who)?.text}}</p></div></div>
</section></Teleport></template>
<style scoped>
.study{position:absolute;inset:0 0 92px;color:var(--text-normal);padding:16px 5%;pointer-events:none;display:flex;flex-direction:column}.study:not(.m0){background:var(--bg-stage)}nav{display:flex;align-items:center;gap:10px;pointer-events:auto;margin:0 auto 18px;max-width:100%;padding:6px 12px;border-radius:8px;background:var(--bg-secondary-alt);font-size:12px}select,button{background:var(--bg-floating);border:1px solid var(--border-strong);color:var(--header-primary);border-radius:4px;padding:5px;font:inherit}nav input{width:90px}time,small{color:var(--text-muted);font-size:12px}article,p{margin:0}strong,b{color:var(--header-primary)}.subtitle{margin:auto auto 0;display:grid;gap:4px}.subtitle article{background:var(--bg-floating);padding:6px 14px;border-radius:5px;font-size:23px}.subtitle strong{font-size:15px;margin-right:8px}.duet,.score,.margin,.floor{width:min(100%,940px);margin:auto;pointer-events:auto}.duet{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.duet>div{min-height:220px;background:var(--bg-secondary-alt);padding:18px;border-radius:8px}.speaker{display:flex;align-items:center;gap:8px}.speaker i{font-size:11px;color:var(--green)}.duet p{margin-top:18px;font-size:24px}.duet p.old{color:var(--text-muted);font-size:16px}.ticks{margin-left:82px;display:flex;justify-content:space-between;color:var(--text-muted);font:12px monospace}.track{display:grid;grid-template-columns:82px 1fr;align-items:center;height:34px}.strip{position:relative;height:18px;background:var(--bg-secondary-alt)}.strip span{position:absolute;background:var(--blurple,#5865f2);height:100%;border-radius:4px}.script{margin-top:25px}.script p{display:grid;grid-template-columns:50px 65px 1fr;padding:8px 0;font-size:18px}.margin{max-width:750px;display:grid;grid-template-columns:2fr 1fr;align-items:center;gap:18px}.margin>div{grid-column:1}.margin .aside{grid-column:2;grid-row:2;border-left:2px solid var(--border-strong);padding-left:14px}.margin b,.floor b{display:block;font-size:14px}.margin p,.floor p{font-size:24px}.margin small{display:block}.floor{display:grid;grid-template-columns:1fr 1fr;gap:26px 70px;max-width:800px}.floor>div{display:grid;grid-template-columns:52px 1fr;align-items:center;border-radius:14px;padding:16px;background:var(--bg-secondary-alt)}.floor p{grid-column:2}.floor>div:last-child{grid-column:1/3;justify-self:center}.floor .lit{outline:2px solid var(--green)}
@media(max-width:600px){nav{gap:3px;flex-wrap:wrap}nav input{width:55px}.study{padding:8px;overflow:auto}.duet{grid-template-columns:1fr;gap:4px}.duet>div{min-height:0;padding:7px}.duet p,.margin p,.floor p{font-size:17px}.floor{gap:8px}.floor>div{display:block;padding:8px}.subtitle article{font-size:18px}}
</style>
