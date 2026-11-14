<script setup lang="ts">
import {computed, ref, watchEffect, onMounted, onBeforeUnmount} from 'vue'
import Room from '../../src/screens/Room.vue'
import Avatar from '../../src/components/Avatar.vue'
import {call} from '../../src/call'
import {cast,turns} from './exchange'
const modes=['Fork','Facing pages','Orbit']
call.selfId='Pi'
call.status='connected'
call.members=cast.map(({name},i)=>({id:name,name,joinedAt:i+1,away:false,muted:false,deafened:false}))
const ready=ref(false), mode=ref(0), t=ref(8.55), playing=ref(false)
let tick=0
onMounted(()=>{ready.value=true;let last=performance.now();tick=window.setInterval(()=>{const now=performance.now();if(playing.value){t.value=Math.min(14,t.value+(now-last)/1000);if(t.value>=14)playing.value=false}last=now},50)})
onBeforeUnmount(()=>clearInterval(tick))
function toggle(){if(t.value>=14)t.value=0;playing.value=!playing.value}
const lines=computed(()=>turns.map(b=>b.revisions.filter(([s])=>s<=t.value).at(-1)?.[1]||''))
const speaking=(v:number)=>turns.some(b=>b.voice===v&&b.start<=t.value&&b.stop>t.value)
watchEffect(()=>{call.speaking=new Set(cast.filter((_,i)=>speaking(i)).map(p=>p.name))})
const visible=(i:number)=>!!lines.value[i]
const speaker=(i:number)=>cast[turns[i]!.voice]!
const lastFor=(voice:number)=>turns.map((b,i)=>b.voice===voice&&visible(i)).lastIndexOf(true)
const paths=['M12 0 V100','M12 42 C12 76 90 50 90 87 V100','M12 18 C12 55 54 32 54 72 V100']
</script>
<template><Room/><Teleport v-if="ready" to="main.stage"><section class="sheet" :class="'mode'+mode">
<header><div class="cast"><span v-for="(p,i) in cast" :style="{'--ink':p.ink}" :class="{talk:speaking(i)}"><Avatar :name="p.name" :hue="p.hue" :size="22"/>{{p.name}}</span></div>
<select v-model="mode" aria-label="Prototype"><option v-for="(name,i) in modes" :value="i">{{name}}</option></select></header>
<div class="canvas">
<div v-if="mode===0" class="fork">
<div v-if="visible(0)" class="opening"><b>Pi</b>{{lines[0]}}</div>
<div class="origin" v-if="visible(2)"><b>Mira</b>Four.</div><div class="junction"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path v-for="(path,j) in paths" v-show="visible([2,4,3][j]!)" :d="path" :stroke="speaker([2,4,3][j]!).ink" pathLength="1" vector-effect="non-scaling-stroke"/></svg></div>
<div class="limbs"><div v-for="i in [2,3,4]" :style="{'--ink':speaker(i).ink}"><template v-if="visible(i)"><b>{{speaker(i).name}}</b><p>{{i===2 ? lines[i]?.replace(/^Four[.] ?/,'') : lines[i]}}</p></template></div></div>
<div v-if="visible(5)" class="return"><b>Mira</b>{{lines[5]}}</div></div>
<div v-if="mode===1" class="pages"><div class="leftpage"><div v-if="visible(0)" class="opening"><b>Pi</b>{{lines[0]}}</div><div v-if="visible(2)" class="lead"><b>Mira</b><p>{{lines[2]}}</p></div><div v-if="visible(5)" class="return"><b>Mira</b>{{lines[5]}}</div></div><div class="rightpage"><div v-for="i in [3,4]" :style="{'--ink':speaker(i).ink}"><template v-if="visible(i)"><b>{{speaker(i).name}}</b><p>{{lines[i]}}</p></template></div></div></div>
<div v-if="mode===2" class="orbit"><svg viewBox="0 0 800 310" preserveAspectRatio="none" aria-hidden="true"><ellipse cx="400" cy="154" rx="293" ry="117"/><ellipse cx="400" cy="154" rx="269" ry="104"/><path d="M158 91 Q382 233 640 95" v-if="visible(4)"/></svg><div v-for="(p,v) in cast" class="island" :class="['v'+v,{talk:speaking(v)}]" :style="{'--ink':p.ink}"><div class="who"><Avatar :name="p.name" :hue="p.hue" :size="32"/><b>{{p.name}}</b></div><p>{{lines[lastFor(v)]}}</p></div></div>
</div><footer><button @click="toggle">{{playing?'Pause':t>=14?'Replay':'Play'}}</button><input aria-label="Call position" v-model.number="t" type="range" min="0" max="14" step=".05"><time>{{t.toFixed(1)}} s</time></footer>
</section></Teleport></template>
<style scoped>
.sheet{position:absolute;inset:0 0 85px;background:var(--bg-stage);color:var(--header-primary);display:flex;flex-direction:column;overflow:auto}.sheet header,.sheet footer{display:flex;align-items:center;justify-content:space-between;width:min(92%,960px);margin:0 auto;padding:14px 0}.sheet header{border-bottom:1px solid var(--border-subtle)}.cast,.cast span,.who{display:flex;align-items:center;gap:8px}.cast{gap:18px}.cast span{font-size:12px;color:var(--header-secondary)}.talk .avatar{outline:2px solid var(--ink);outline-offset:2px}.sheet select,.sheet button{background:var(--bg-secondary-alt);color:var(--header-primary);border:1px solid var(--border-strong);border-radius:6px;padding:6px 9px}.canvas{width:min(90%,890px);margin:auto;min-height:270px;display:grid;align-items:center}.sheet b{display:block;color:var(--ink,var(--header-secondary));font-size:13px;line-height:1.5;font-weight:650;margin-bottom:5px}.sheet p{margin:0;text-wrap:pretty}.opening,.return{font-size:22px;line-height:1.3}.opening b,.return b{display:inline-block;margin-right:12px}.opening{color:var(--header-secondary)}.return{margin-top:20px}.origin{margin:14px 0 0 9%;font-size:26px;line-height:1.1}.origin b{color:#ffc39f}.junction{height:48px}.junction svg{width:100%;height:100%;fill:none;stroke-width:2}.limbs{display:grid;grid-template-columns:42% 19% 39%}.limbs>div{padding:10px 8px}.limbs>div:nth-child(2){text-align:center}.limbs>div:last-child{padding-left:10%;text-align:right}.limbs p{font-size:clamp(20px,3.2vw,37px);line-height:1.14;letter-spacing:-.04em}.pages{display:grid;grid-template-columns:1.5fr 1fr}.leftpage{padding:10px 7% 10px 0}.rightpage{padding:25px 0 10px 12%;border-left:1px solid var(--border-strong);display:grid;align-content:center;gap:20px}.lead{margin-top:24px;--ink:#ffc39f}.lead p{font-size:clamp(30px,5vw,56px);line-height:1.04;letter-spacing:-.052em}.rightpage p{font-size:clamp(21px,3.2vw,34px);line-height:1.13;letter-spacing:-.035em}.orbit{position:relative;min-height:310px}.orbit svg{position:absolute;width:100%;height:100%;fill:none;stroke:var(--border-strong);stroke-width:1}.orbit path{stroke:#747988;stroke-dasharray:2 6}.island{position:absolute;width:35%;padding:6px 10px;background:var(--bg-stage)}.island p{font-size:clamp(20px,3vw,31px);line-height:1.14;letter-spacing:-.035em}.who{margin-bottom:7px}.who b{margin:0}.v0{left:0;top:10%}.v1{right:0;top:10%}.v2{bottom:0;left:36%;width:28%;text-align:center}.v2 .who{justify-content:center}.sheet footer{justify-content:center;gap:12px;padding:6px 0}.sheet input{width:140px;accent-color:var(--brand-soft)}time{color:var(--text-muted);font:12px var(--font-code)}
@media(prefers-reduced-motion:no-preference){.junction path{stroke-dasharray:1;animation:trace .35s ease-out both}@keyframes trace{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}}.sheet input:focus:not(:focus-visible){outline:none}@media(max-width:520px){.sheet header{padding:8px 0}.cast{gap:6px}.cast span{gap:3px}.canvas{width:94%}.sheet b{font-size:12px}.opening,.return{font-size:17px}.limbs>div{padding:4px}.junction{height:48px}.island{width:44%}.v2{left:28%}.pages .opening b{display:block}.orbit{min-height:280px}}
</style>
