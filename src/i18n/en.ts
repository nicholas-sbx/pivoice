/**
 * Every word the site shows, in one place. To change the wording, change it
 * here; to add a language, add a file shaped like this one (see index.ts).
 * The format is vue-i18n's: https://vue-i18n.intlify.dev/guide/essentials/syntax
 *
 * - `{name}` is filled in from the params given to `t()`.
 * - `a | b` is a plural (one | other), picked by the `count` param.
 * - Keys are grouped by where they show up. Where the same words appear in
 *   several places, they share one key (common.*, spatial.*, route.*).
 */

export const en = {
  // Shared
  'common.close': 'Close',
  'common.dismiss': 'Dismiss',
  'common.mute': 'Mute',
  'common.unmute': 'Unmute',
  'common.deafen': 'Deafen',
  'common.undeafen': 'Undeafen',
  'common.disconnect': 'Disconnect',
  'common.connecting': 'Connecting…',
  'common.reconnecting': 'Reconnecting…',
  'common.default': 'Default',
  'common.systemDefault': 'System default',
  'common.off': 'Off',
  'common.reset': 'Reset',
  'common.beta': 'Beta',
  'common.resetToDefaults': 'Reset to defaults',
  'common.microphone': 'Microphone',
  'common.speaker': 'Speaker',

  // Spatial audio
  'spatial.title': 'Spatial Audio',
  'spatial.stereo': 'Stereo',
  'spatial.binaural': 'Binaural',
  'spatial.hrtf': 'HRTF',
  'spatial.label': 'Spatial Audio: {mode}',
  'spatial.labelOff': 'Spatial Audio: Off',
  'spatial.offHint': 'Straight to your ears. Lowest latency.',
  'spatial.stereoHint': 'Louder on the side they sit: panned by level only.',
  'spatial.binauralHint':
    'A modelled head between your ears: the ear away from someone hears them up to 0.66 ms later and duller, the near one a little brighter, so voices sound placed around the table rather than just louder on one side. Only the far ear waits; the person across from you sounds just as with it off. On headphones.',
  'spatial.hrtfHint': 'Full 3D around your head, on headphones.',

  // Toasts and errors
  'toast.downloadLinkCopied': 'Download link copied',
  'toast.inviteCopied': 'Invite link copied',
  'toast.inviteCopyFailed': "Couldn't copy the invite link.",
  'toast.codeCopied': 'Room code copied',
  'toast.micBlocked': 'Microphone blocked. You can listen, but nobody can hear you.',
  'toast.micFailed': "Couldn't open a microphone. You can listen, but nobody can hear you.",
  'toast.micAllow': 'Allow the microphone in your browser, then rejoin.',
  'toast.micNone': 'No microphone to unmute.',
  'toast.popOutFailed': "Couldn't open the pop-out window.",
  'error.notFound': "There's no room with that code. Check it and try again.",
  'error.full': 'That room is full.',
  'error.unreachable': "Couldn't reach the room. Check your connection and try again.",
  'error.unsupported': "This browser can't make voice calls.",
  'error.version': 'That room is on a newer version of Pivoice. Reload the page to update.',
  'error.busy': "Couldn't find a free room code. Try again.",
  'error.lostRoom': 'Lost the connection to the room.',

  // Start screen
  'home.titleInvite': "You've been invited to a call",
  'home.title': 'Pull up a chair',
  'home.subInvite': 'Your friends are waiting for you.',
  'home.sub': 'Make a room and share the code, or join one you were given.',
  'home.updateOut': 'Pivoice app {newer} is out (you have {current}):',
  'home.updateLink': 'download it',
  'home.updateAfter': 'when you get a moment.',
  'home.displayName': 'Display Name',
  'home.required': 'This field is required',
  'home.createRoom': 'Create a Room',
  'home.createHint': 'Get a code to share with your friends',
  'home.creating': 'Creating',
  'home.haveCode': 'Have a code already?',
  'home.roomCode': 'Room Code',
  'home.fromInvite': '· from your invite',
  'home.codeLength': 'Codes are {length} characters',
  'home.codeEnter': 'Enter a room code',
  'home.join': 'Join Room',
  'home.joining': 'Joining',
  'home.makeNew': 'Or make a new room instead',
  'home.getApp': 'Lowest latency in the app',
  'home.headphones': 'Best with headphones',
  'home.version': 'v{version}',
  'home.appVersion': '· app {version}',

  // The room's top bar and controls
  'room.title': 'Voice Room',
  'room.codeAria': 'Room code {code}',
  'room.codeHidden': 'Room code hidden',
  'room.hideCode': 'Hide code',
  'room.showCode': 'Show code',
  'room.hideCodeAria': 'Hide room code',
  'room.showCodeAria': 'Show room code',
  'room.copyCode': 'Copy room code',
  'room.connected': 'Voice Connected',
  'room.inCall': '{count} in the call',
  'room.popOutClose': 'Close pop-out table',
  'room.popOut': 'Pop out table',
  'room.overlayHide': 'Hide overlay',
  'room.overlayShow': 'Show overlay',
  'room.displaySettings': 'Display settings',
  'room.copyInviteLink': 'Copy invite link',
  'room.copyInvite': 'Copy Invite',
  'room.controls': 'Call controls',
  'room.voiceSettings': 'Voice Settings',

  // The table
  'table.count': '{count} person at the table | {count} people at the table',
  'table.reconnecting': 'reconnecting…',
  'table.menuLeft': 'Left the call',
  'menu.userVolume': 'User Volume',
  'menu.backTo100': 'Back to 100%',

  // What the table shows about each connection
  'route.local': 'Same network',
  'route.direct': 'Direct, peer to peer',
  'route.relayedVia': 'Relayed via {host}',
  'route.relayedTheirs': 'Relayed via their TURN',
  'route.engineLL': 'Low latency',
  'route.engineLLLong': 'Low-latency engine',
  'route.engineWebRTC': 'WebRTC',
  'route.engineWebRTCLong': 'WebRTC audio',
  'route.toRelay': '{protocol} to relay',
  'route.mouthToEar': '{ms} ms mouth to ear',
  'route.mouthToEarApprox': '≈ {ms} ms mouth to ear',
  'route.measuredTitle':
    "Measured: their capture time (stamped on the audio) to when it reached your speakers. Exact on one machine; across machines it's as good as your two clocks.",
  'route.breakdown.mic': 'Microphone: {ms} ms (yours, as your browser reports it)',
  'route.breakdown.codec': 'Codec: {ms} ms (10 ms Opus frame + lookahead)',
  'route.breakdown.network': 'Network: {ms} ms (half the round trip)',
  'route.breakdown.buffer': 'Jitter buffer: {ms} ms',
  'route.breakdown.playout': 'Playout: {ms} ms (browser to speakers)',
  'route.breakdown.unknown': '? = not reported by this browser, counted as 0.',
  'route.parts': 'mic {mic} · codec {codec} · net {net} · buffer {buffer} · out {out}',
  'route.llStats': 'target {target} ms · late {late} · concealed {concealed}%',
  'route.jitterGaps': 'jitter {jitter} · gaps {loss}',
  'route.jitterLoss': 'jitter {jitter} · loss {loss}',

  // The app banner and gate
  'banner.label': 'Get the app',
  'banner.text': "Lower latency in the Pivoice app for {os}: it does the audio itself, without the browser's buffers.",
  'banner.download': 'Download for {os}',
  'gate.lostTitle': 'Lost the Pivoice app',
  'gate.lostText': "The page can't reach the app any more. It may have quit: open Pivoice again",
  'gate.lostInWindow': 'and this window comes back with it.',
  'gate.lostInBrowser': 'and it opens a fresh page for you.',
  'gate.tryAgain': 'Try Again',
  'gate.useBrowser': 'Use This Browser Instead',
  'gate.updateTitle': 'Update the Pivoice app',
  'gate.updateText':
    'This app (version {current}) is too old for the site. Download version {latest}, quit this one, and open the new one.',
  'gate.download': 'Download {version}',
  'gate.downloadFor': 'Download {version} for {os}',
  'gate.copyLink': 'Copy Link',
  'gate.allPlatforms': 'All Platforms',
  'gate.restartTitle': 'Restart the Pivoice app',
  'gate.restartText':
    "This app (version {current}) is newer than the page it loaded. Quit Pivoice and open it again to load the current site. Still here after that? The site's update is on its way: try again in a few minutes.",
  'gate.reload': 'Reload',

  // Display panel
  'display.atTable': 'At the table',
  'display.ping': 'Show ping',
  'display.pingHint': 'Round trip to each person, beside their name.',
  'display.route': 'Show audio route',
  'display.routeHint': "How each person's audio reaches you: direct or relayed, buffering, loss.",
  'display.onDevice': 'On this device',
  'display.awake': 'Keep screen awake',
  'display.awakeHint': "Stops the screen going to sleep while you're in a call.",

  // Voice settings
  'settings.title': 'Voice Settings',
  'settings.tabVoice': 'Voice',
  'settings.tabLL': 'Low Latency',
  'settings.tabOverlay': 'Overlay',
  'settings.inputDevice': 'Input Device',
  'settings.outputDevice': 'Output Device',
  'settings.inputLevel': 'Input Level',
  'settings.micTest': 'Mic Test',
  'settings.micTestNote':
    "Hear yourself through one path, with no network in the way, and see how long it takes. You're deafened while it runs.",
  'settings.pathRaw': 'Raw',
  'settings.pathWebRTC': 'WebRTC audio',
  'settings.pathLL': 'Low latency',
  'settings.hintRawApp':
    'Mic straight to your ears inside the sound card’s own callback, like pw-loopback. The floor every path sits on.',
  'settings.hintRawBrowser':
    'Mic straight to your ears: your devices and the browser’s buffers. The floor every path sits on.',
  'settings.hintWebRTC': 'Through WebRTC’s encoder, jitter buffer and playout, exactly as a call, minus the network.',
  'settings.hintLL':
    'Through the low-latency engine: its silence gate, encoder, packets, decoder and jitter buffer, minus the network.',
  'settings.stopTesting': 'Stop Testing',
  'settings.startTesting': "Let's Check",
  'settings.testMicToEars': 'mic to ears',
  'settings.testMicToEarsMeasured': 'mic to ears, measured',
  'settings.micBlocked': 'Microphone access is blocked for this site.',
  'settings.micNone': 'No microphone found.',
  'settings.processing': 'Voice Processing',
  'settings.echo': 'Echo Cancellation',
  'settings.noise': 'Noise Suppression',
  'settings.agc': 'Automatic Gain Control',
  'settings.echoHint':
    'Takes what your speakers play back out of your mic (SpeexDSP). Adds at most one 2.7 ms block, none at all on most sound cards. Only if you’re not on headphones.',
  'settings.noiseNotBuilt': 'Not in this build of the app.',
  'settings.noiseHint':
    'RNNoise: a small neural network takes out fans, keyboards and hum. Adds 10 ms (its analysis window) plus up to 10 ms to fill a frame.',
  'settings.noiseHintLookahead':
    'RNNoise: a small neural network takes out fans, keyboards and hum. Adds 10 ms (its analysis window) plus up to 10 ms to fill a frame, plus 10 ms of lookahead.',
  'settings.agcHint':
    'Brings your voice to a steady level by changing the app’s own gain (never your system’s mic volume): down for a loud mic, up for a quiet one. Adds no delay.',
  'settings.lookahead': 'Lookahead',
  'settings.lookaheadHint':
    'RNNoise as its authors run it: it hears the next 10 ms before deciding, so the first sound of each word comes through cleaner. Costs those 10 ms. Off, nothing is held back.',
  'settings.gate': 'Voice gate',
  'settings.gateOff': 'Off: noise is taken out, but you’re never faded to silence.',
  'settings.gateOn':
    'Fades you out when RNNoise is less than {pct}% sure you’re talking. Lower keeps more of quiet words; higher cuts more noise between them.',
  'settings.gateHold': 'Gate hold',
  'settings.gateHoldHint':
    'How long the gate stays open after you stop, so word endings and pauses mid-sentence aren’t cut. It opens again the moment you speak; nothing is held back to look ahead.',
  'settings.agcTarget': 'Target level',
  'settings.agcTargetHint':
    'How loud it brings your speech on average. Higher is louder; the peak ceiling below keeps the peaks in check either way.',
  'settings.agcCeiling': 'Peak ceiling',
  'settings.agcCeilingHint':
    'The loudest it lets your recent peaks get. It holds the gain back rather than squash them, so lower is cleaner, higher is louder. Anything sudden past −1 dBFS is caught by the limiter.',
  'settings.agcMax': 'Max boost',
  'settings.agcMaxHint': 'The most it will turn a quiet mic up. More reaches quieter mics, and lifts their background noise with them.',
  'settings.agcRise': 'Rise time',
  'settings.agcRiseHint':
    'How long it takes to turn you up when you get quieter. Slower sounds steadier; faster catches up sooner.',
  'settings.agcFall': 'Fall time',
  'settings.agcFallHint':
    'How long it takes to turn you down when you get loud. Fast keeps a sudden loud bit from blasting; too fast can pump.',
  'settings.resetGain': 'Reset gain control',
  'settings.appProcessingNote': 'All off, the app doesn’t touch your mic at all, and none of it costs anything.',
  'settings.browserProcessingNote':
    "The browser's own. All three off is the lowest latency: the browser hands your mic over untouched. Echo cancellation is for when you're not on headphones.",
  'settings.dtx': 'Silence Suppression (DTX)',
  'settings.dtxHint':
    "People stop sending you audio while they're quiet. Saves bandwidth, adds ~9 ms of buffering. Changing it reconnects you for a moment.",

  // Low-latency settings
  'll.engine': 'Low-Latency Engine (Experimental)',
  'll.engineHint':
    'Replaces WebRTC’s audio with people who have it on too: the browser’s Opus at frame sizes WebRTC won’t do, our own jitter buffer, and packets that are never retransmitted.',
  'll.engineUnsupported': 'This browser doesn’t have WebCodecs audio, which the engine needs.',
  'll.fixedDelay': 'Fixed delay',
  'll.costRest': '({what}) · {packets} packets/s · ≈ {kbps} kbps per listener · {transport}',
  'll.costOneBlock': 'one block',
  'll.costFrame': 'frame + lookahead',
  'll.transportApp': 'straight from the sound card’s callback',
  'll.transportShared': 'shared memory between audio thread and worker',
  'll.transportMessages': 'messages between audio thread and worker',
  'll.soundCard': 'Sound card',
  'll.soundCardNote':
    'The app runs the microphone and the speakers in one callback, with the smallest buffer your device offers, and plays everyone through it: there’s no browser audio in the way.',
  'll.now': 'Now: {buffer}',
  'll.exclusive': 'Exclusive Mode',
  'll.exclusiveHint':
    'Takes the sound card for the app alone, for WASAPI’s smallest buffers: less delay, but nothing else can play or record on it while you’re in a call. Without it, the app still asks Windows for the mic raw (no effects).',
  'll.glitches': 'Glitches since the sound card opened',
  'll.glitch.inputOverflows': 'mic overruns',
  'll.glitch.inputOverflowsHint': 'the sound card’s mic buffer filled before the app read it',
  'll.glitch.outputUnderflows': 'speaker underruns',
  'll.glitch.outputUnderflowsHint': 'a block reached the speakers late',
  'll.glitch.captureDropped': 'mic blocks dropped',
  'll.glitch.captureDroppedHint': 'the sender fell behind',
  'll.glitch.framesDropped': 'incoming frames dropped',
  'll.glitch.framesDroppedHint': 'the audio thread fell behind',
  'll.glitch.gcPause': 'longest pause',
  'll.glitch.gcPauseHint': 'the longest the app stopped for garbage collection lately',
  'll.glitchesNote':
    'Hear a crackle? Whatever counted up just then is why. Underruns or overruns: the sound card wants a bigger buffer, or something else on the machine is hogging it. Late frames in someone’s route card: the network.',
  'll.bothEngines': 'Both engines',
  'll.outputBuffer': 'Audio output buffer',
  'll.bufferMin': 'Smallest',
  'll.bufferSmall': 'Small (~5 ms)',
  'll.bufferDefault': 'Browser default',
  'll.outputBufferNote':
    'Web Audio’s buffer to your speakers (this engine always plays through it). Smaller is less delay and steadier timing, but crackles sooner on a busy machine: if this engine sounds choppy, try a bigger one with the Raw mic test. Changing it reconnects you for a moment.',
  'll.bufferNow':
    '{block}-sample blocks ({blockMs} ms) · in {input} ms, out {output} ms · {api}',
  'll.bufferNowMode': '{block}-sample blocks ({blockMs} ms) · in {input} ms, out {output} ms · {api} ({mode})',
  'll.bufferWebAudio': '{base} ms Web Audio + {device} ms device',
  'll.micSilent': 'silent',
  'll.sending': 'Sending',
  'll.codec': 'Codec',
  'll.codecOpus': 'Opus',
  'll.codecPCM': 'Raw PCM (LAN)',
  'll.codecPCMNote':
    'Raw 16-bit PCM: no encoder and no lookahead, one 2.7 ms block per packet, as soon as it’s captured. Megabits per listener (see above): for local networks.',
  'll.codecOpusNote':
    'The browser’s Opus: a fraction of the bandwidth, at the cost of a frame to fill and the encoder’s lookahead.',
  'll.frameSize': 'Frame size',
  'll.opusMode': 'Opus mode',
  'll.appLowdelay': 'Low delay',
  'll.appVoip': 'VoIP',
  'll.appAudio': 'Audio',
  'll.appLowdelayHint': 'CELT only: 2.5 ms lookahead. Lowest delay.',
  'll.appVoipHint': 'Tuned for speech: 6.5 ms lookahead. Below 10 ms frames it’s CELT anyway.',
  'll.appAudioHint': 'Tuned for music: 6.5 ms lookahead.',
  'll.bitrate': 'Bitrate',
  'll.complexity': 'Encoder complexity',
  'll.complexityHint': 'CPU against quality. No effect on delay.',
  'll.redundancy': 'Redundancy',
  'll.redundancy1': '+1 frame',
  'll.redundancy2': '+2 frames',
  'll.redundancyNote':
    'Each packet repeats the frames before it, so one lost packet costs nothing. More bandwidth, no extra delay.',
  'll.dtxHint': 'Send nothing while you’re quiet.',
  'll.silenceThreshold': 'Silence threshold',
  'll.silenceThresholdHint':
    'Quieter than this counts as silence. Your mic right now: {level}. Lower it if quiet words get cut; raise it if room noise keeps it sending.',
  'll.silenceHangover': 'Silence hangover',
  'll.silenceHangoverHint':
    'Keep sending this long after you go quiet, so word endings and pauses mid-sentence aren’t cut.',
  'll.receiving': 'Receiving (jitter buffer)',
  'll.receivingNote':
    'It aims for the network’s jitter (the chosen percentile of how late packets have been, over the window) × multiplier + margin, kept between the minimum and the maximum. Choppy? Raise the percentile or the margin. Laggy? Lower them.',
  'll.jitterPercentile': 'Jitter percentile',
  'll.jitterPercentileHint':
    'How much of the lateness to cover: 99 drops about 1 packet in 100 as late; 100 covers the worst one seen.',
  'll.jitterWindow': 'Jitter window',
  'll.jitterWindowHint':
    'How far back it remembers lateness. Longer is steadier; shorter recovers faster after a bad patch.',
  'll.jitterMultiplier': 'Jitter multiplier',
  'll.margin': 'Safety margin',
  'll.minBuffer': 'Minimum buffer',
  'll.maxBuffer': 'Maximum buffer',
  'll.stretch': 'Speed adjustment',
  'll.stretchHint':
    'How much playback may speed up or slow down to steer to the target (the pitch moves with it). It does that in the pauses between words, and while someone talks only if a gap is coming. 0 = only resync between sentences.',
  'll.conceal': 'Concealment',
  'll.concealHint': 'How long a gap is covered by fading out the last frame before it goes silent.',

  // Overlay settings
  'overlay.show': 'Show overlay',
  'overlay.showHint':
    "The table, small, over everything else on your screen while you're in a call. Clicks go straight through it.",
  'overlay.error': "Couldn't show it: {error}",
  'overlay.gnome':
    "This desktop (GNOME) doesn't let apps keep a window on top or say where it goes. Move the overlay with Super and drag, and pin it with Alt+Space, Always on Top. It takes clicks here, so you can.",
  'overlay.windows':
    "Over games too: borderless or windowed full screen, and most that say exclusive (Windows runs them through the desktop anyway). Not over a game in true exclusive full screen, which draws past the desktop altogether: if it doesn't show, set the game to borderless, or leave Windows' fullscreen optimizations on for it.",
  'overlay.screen': 'Screen',
  'overlay.screenCurrent': 'The one Pivoice is on',
  'overlay.screenLabel': '{name} ({width} × {height})',
  'overlay.screenPrimary': '{label}, primary',
  'overlay.screenMissing':
    "The screen you picked isn't connected, so it's on the one Pivoice is on until it is.",
  'overlay.position': 'Position',
  'overlay.anchor.top-left': 'Top left',
  'overlay.anchor.top': 'Top',
  'overlay.anchor.top-right': 'Top right',
  'overlay.anchor.left': 'Left',
  'overlay.anchor.center': 'Middle',
  'overlay.anchor.right': 'Right',
  'overlay.anchor.bottom-left': 'Bottom left',
  'overlay.anchor.bottom': 'Bottom',
  'overlay.anchor.bottom-right': 'Bottom right',
  'overlay.margin': 'Distance from the edge',
  'overlay.marginCenter': 'Not in the middle: it has no edge to keep from.',
  'overlay.marginHint': 'From the part of the screen windows get, so it never sits under a taskbar or panel.',
  'overlay.size': 'Size',
  'overlay.sizeHint': 'Its width and height.',
  'overlay.scale': 'Scale',
  'overlay.scaleHint': 'How big the faces and names are in it.',
  'overlay.opacity': 'Opacity',
  'overlay.opacityHint': "The table and anyone quiet. Whoever's speaking always shows in full.",
  'overlay.placing': 'Overlay'
}

export type MessageKey = keyof typeof en
