export const cast = [
  { name: 'Mira', ink: '#ffc39f', hue: 28 },
  { name: 'Theo', ink: '#a5baff', hue: 230 },
  { name: 'Pi', ink: '#a4dbc1', hue: 145 }
]
export interface Utterance {
  voice: number
  start: number
  stop: number
  revisions: [number, string][]
}
export const turns: Utterance[] = [
  {voice:2,start:0,stop:1.6,revisions:[[.55,'Which platform'],[1.9,'Which platform are you on?']]},
  {voice:1,start:2.1,stop:2.6,revisions:[]},
  {voice:0,start:3,stop:8.7,revisions:[[3.8,'Four.'],[4.7,'Four. Hang on,'],[6.8,'Four. Hang on, that’s the old'],[8.9,'Four. Hang on, that’s the old board.']]},
  {voice:2,start:4.9,stop:5.5,revisions:[[5.6,'Oh.']]},
  {voice:1,start:6.0,stop:8.1,revisions:[[7.2,'I see you'],[8.5,'I see you across the tracks.']]},
  {voice:0,start:10.7,stop:12.4,revisions:[[11.3,'There you are.'],[12.8,'There you are. Platform five.']]}
]
