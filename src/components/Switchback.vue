<script setup lang="ts">
import { computed } from 'vue'
type Row = { id:number; overlapRoot:number|null; name:string; text:string; color:string }
const props=defineProps<{messages:Row[]}>()
const visibleIds=computed(()=>new Set(props.messages.map(m=>m.id)))
</script>
<template><ol class="switchback"><li v-for="m in messages" :key="m.id" :class="{branch:m.overlapRoot!==null && visibleIds.has(m.overlapRoot)}" :style="{'--ink':m.color}" :data-message-id="m.id">
<i aria-hidden="true"/><strong>{{m.name}}</strong><span>{{m.text}}</span>
</li></ol></template>
<style scoped>
.switchback{list-style:none;padding:0 16px;margin:0;font-size:calc(15px * var(--caption-scale,1));line-height:1.44}
li{position:relative;display:grid;grid-template-columns:8px minmax(3em,5em) minmax(0,1fr);gap:8px;align-items:baseline;padding:3px 0}
strong{color:var(--ink);font-size:inherit;font-weight:600;overflow-wrap:anywhere}
span{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text-normal)}
i{height:6px;width:6px;border-radius:50%;background:var(--ink);align-self:start;margin-top:.52em}
.branch{margin-left:20px}
.branch:before{content:'';position:absolute;left:-18px;top:-4px;height:calc(.52em + 10px);width:16px;border:solid var(--border-strong);border-width:0 0 1px 1px;border-bottom-left-radius:7px}
@media(max-width:540px){.switchback{padding:0 9px}li{grid-template-columns:6px minmax(2.5em,3.5em) minmax(0,1fr);gap:5px}.branch{margin-left:12px}.branch:before{left:-10px;width:9px}}
</style>
