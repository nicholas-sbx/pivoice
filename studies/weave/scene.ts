// Synthetic room-clock seconds. Each turn has its own cadence and recognition lag.
export const names=['Mira','Theo','Pi']
export const colors=['#ffc29f','#aebfff','#9fddc4']
const script:[number,number,number,string][]=[
 [2,0,.22,'Which platform are you on? I can see two boards from the stairs.'],
 [0,3.9,.24,'Four. If you follow the painted line past the coffee stand you should come out right beside the old departure board.'],
 [1,5.8,.27,'Wait, I can see you across the tracks.'],
 [2,7.1,.24,'Oh, the old board.'],
 [0,11.4,.23,'Hang on. That clock above the ticket office has stopped. I think we are looking at yesterday’s departures.'],
 [1,13.7,.28,'Mine says platform five.'],
 [2,16.2,.24,'Five, got it.'],
 [1,19.2,.24,'Stay where you are. I’ll come over the bridge and meet you at the bottom of the steps.'],
 [0,20.9,.25,'The steps by the blue sign?'],
 [2,22.1,.23,'I see him now.'],
 [1,25.8,.26,'Yeah. Right there.']
]
export const turns=script.map(([voice,start,step,text],id)=>{
 let at=start
 const words=text.split(' ').map((text,index)=>{
  const onset=at;at+=step*(1+((index%3)-1)*.18)+(/[.,?]$/.test(text)?.11:0)
  return {voice,id,index,text,start:onset,end:at-.035,arrives:at+(voice===2?.88:.34)}
 })
 return {id,voice,start,end:at,words}
})
