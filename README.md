# Pivoice

**Voice rooms around a round table.** Make a room, share the code, talk.

Everyone sits around a table seen from above. You're always at the bottom,
and everyone else is spread evenly around it. When people join or leave, the
others slide to their new seats, each moving as little as possible. Turn on
spatial audio and each voice comes from where that person sits.

<p>
  <img src="docs/screenshots/room-6.jpg" width="49%" alt="Six people at the table">
  <img src="docs/screenshots/settings.jpg" width="49%" alt="Voice settings">
</p>
<p>
  <img src="docs/screenshots/home.jpg" width="49%" alt="Make or join a room">
  <img src="docs/screenshots/invite.jpg" width="49%" alt="Opening an invite link">
</p>

Built for the lowest latency first, desktop first, and for people on
headphones. No accounts, no server in the middle of the audio.

## Try it

You need Node 22.12 or newer (CI uses 24, see `.nvmrc`).

```sh
npm install
npm run dev
```

Open it in two browsers (or two profiles), make a room in one and join with
the code in the other. Microphone permission is needed on `localhost` or
HTTPS.

To run without the public PeerJS broker:

```sh
npm run peer:local   # terminal 1: PeerJS broker on localhost:9000
npm run dev:local    # terminal 2: the app, pointed at that broker
npm run e2e          # optional: headless Chromium tabs with fake mics, end to end
```

The e2e run makes a room, has people join, checks everyone hears everyone
(the fake mic beeps, which lights up speaking rings on the other screens),
mutes, has the **host** leave and checks the call carries on, joins someone
new after the hand-over, and fills the table to six. It needs Playwright
installed (`npm i -g playwright && npx playwright install chromium`).
`SHOTS_DIR=docs/screenshots npm run e2e` retakes the screenshots above.

`npm test` runs the unit tests (seat planning against brute force, the
springs, the protocol, the Opus SDP tuning, the Worker), and `npm run
typecheck` / `npm run typecheck:worker` the types.

## What's in it

**Start screen.** No landing page: a name, **Create a Room**, or a room code
and **Join Room**. An invite link (`…/#CODE`) opens straight to the join form
with the code filled in, dotted out, and taken out of the address bar.

**The table.** Top down: a flat round table, you at the bottom, everyone else
evenly around it. Everyone's face is a [blobatar](https://blobatar.dev) made
from their name, so the same name is the same creature on everyone's screen.
Faces idle (breathe, blink), smile while they talk, doze off while deafened,
look puzzled while reconnecting, and turn their eyes toward whoever is
talking. A green ring shows who's talking, and mute and deafen show next to
their names. Right-click someone for **User Volume** and **Mute** (for you only).

**Call controls.** A floating pill at the bottom: mute (`Ctrl+Shift+M`),
deafen (`Ctrl+Shift+D`), spatial audio, voice settings, disconnect. Like
Discord, deafening mutes you too and unmuting undeafens you.

**Room code, hidden by default.** The header shows `••••••` with buttons
to show it and to copy it, so you can screen share without giving the room
away. **Copy Invite** copies the link without showing it. The code shows in
the middle of the table only while you have it revealed.

**Voice settings.** Input and output device, an input level meter,
spatial audio (**Off**, **Stereo**, **HRTF**), and echo cancellation, noise
suppression and automatic gain control, all **off** by default.

### Seating

Angles are measured from your seat at the bottom, clockwise. With N people
the seats are at 2πk/N. Nobody ever slides through your seat, so everyone
else keeps their order around the table.

When someone joins or leaves, [`planSeats`](src/lib/seats.ts) picks which of
the new seats the people already sitting take, keeping their order, so the
total squared distance travelled is as small as possible. It's a small DP over
people × seats, tested against brute force. Squared, so one person doesn't
do all the travelling while everyone else sits still. Newcomers take the
seats left over and fade in. People who leave fade out where they are.

The motion is done in JavaScript: each seat's angle is a critically damped
spring, stepped every animation frame, and it moves along the table's edge,
not in a straight line across it. A change halfway through a move keeps the
seat's speed, so it bends toward its new spot instead of restarting. Because
the angle is known every frame, the spatial audio reads it directly. The loop
stops when everything is still. With reduced motion on, seats jump straight
to where they're going.

### Audio and latency

- **A full mesh of WebRTC calls.** Everyone calls everyone directly, with no
  SFU or relay in the middle unless the network forces TURN. That's the
  lowest latency you can get, and fine for the 12 people a room allows.
- **Raw microphone.** Echo cancellation, noise suppression and auto gain are
  off unless you turn them on. Each adds processing delay, and everyone's on
  headphones.
- **10 ms Opus frames.** The SDP each side sends asks for `ptime=10`
  instead of 20 ms, with in-band FEC, mono and no DTX
  ([`src/net/sdp.ts`](src/net/sdp.ts)). Senders are marked high priority for
  networks that honour DSCP.
- **Spatial audio off by default.** With it off, each voice plays from a plain
  `<audio>` element, the shortest path the browser has from the network to your
  ears.
- **Spatial audio on:** each voice goes `gain → PannerNode → speakers`.
  **Stereo** uses equal-power panning. **HRTF** uses the browser's built-in
  head-related transfer function (`panningModel: 'HRTF'`, in every modern
  browser, so no library is needed) for full 3D on headphones. You sit at the
  bottom facing the middle, so the far side of the table is in front of you
  and the seat on your left is ahead-left. Only the direction counts:
  nobody's quieter for sitting further away. There's no head tracking.

## Rooms: the PeerJS trick

Borrowed from [gasmoney](https://github.com/nicholas-sbx/gasmoney-oneshot).
There's no server of our own. The room **is** a PeerJS id,
`pivoice-v1-room-<CODE>`: whoever holds that id on the free PeerJS broker is the
room's host, and anyone who knows the code connects straight to it. The broker
doubles as the room directory.

- Everyone (the host too) also has a random member id. The voice runs between
  member ids, so it never goes through the host.
- The host only keeps the roster (who's in, muted, deafened) and sends it to
  everyone over data channels. In each pair of members, the one with the
  smaller id places the call, so no call happens twice.
- **The host can leave.** The calls carry on. Everyone works out from the
  last roster who's next in join order. That person claims the room id, and
  everyone else redials it and finds them there. Someone further back in the
  queue waits 2.5 s for each person ahead of them before trying, in case
  those people left too. The broker only lets one person hold an id, so two
  people can never both become host.
- Someone who drops keeps their seat (shown reconnecting) for 12 seconds.
- Codes avoid 0/O/1/I/L/5/S.

**NAT traversal:** STUN first and pray (Google's and Cloudflare's public STUN
plus PeerJS's best-effort relay), with two ways to add a real TURN relay:

1. **Cloudflare TURN through the Worker.** The Worker's `/api/ice` mints
   short-lived Cloudflare Realtime TURN credentials, and the app asks for them
   when a call starts. Set `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` (see
   Releasing). Without them, `/api/ice` answers 404 and the app quietly falls
   back. It only answers same-origin requests from browsers (and any
   `ALLOWED_ORIGINS`), but that stops browsers on other sites, not a
   determined script. If relay bandwidth costs matter, turn on the rate
   limiter in `wrangler.toml`.
2. **Your own TURN server, baked into the build:** `VITE_TURN_URLS`,
   `VITE_TURN_USERNAME` and `VITE_TURN_CREDENTIAL`. Anyone who opens the app
   can read these, so use credentials you can rotate or that only allow
   relaying.

Both can be on at once. The Worker's servers come first.

## Deploying

The app is one Cloudflare Worker named `voice` (from `wrangler.toml`), so it lives at `voice.<your-subdomain>.workers.dev`. It serves
the static build in `dist/`, and `/api/ice` is the only thing that runs code.
CI normally deploys it (next section). By hand:

```sh
npm run build
npx wrangler login
npx wrangler deploy
```

`npm run preview:worker` builds and runs the Worker locally with `wrangler dev`.

Build-time settings (copy `.env.example` to `.env.local` locally; in CI they
come from the repo's Actions variables and secrets):

| Variable | What it does |
| --- | --- |
| `VITE_PUBLIC_URL` | Canonical URL for invite links, e.g. `https://pivoice.example.com/`. Defaults to wherever the app was opened. |
| `VITE_TURN_URLS` | Your TURN server(s), comma separated, e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349`. |
| `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` | Its credentials. |
| `VITE_PEER_HOST/PORT/PATH/SECURE/KEY` | A self-hosted PeerJS broker. Everyone in a room has to use the same one. |

### CI: releasing

Releases work like gasmoney's: there's one workflow,
[`.github/workflows/release.yml`](.github/workflows/release.yml), and it only
runs when you release. Ordinary pushes and pull requests don't trigger
anything, so run `npm test` and `npm run typecheck` yourself before pushing.

A release starts in one of three ways:

- **Bump the version on main** and push:
  `npm version patch --no-git-tag-version`, then commit `package.json` and
  `package-lock.json` as "Release 0.1.1". If there's no `v0.1.1` tag yet, CI
  adds it and releases.
- **Push a tag** yourself, e.g. `npm version minor && git push --follow-tags`.
- **Run workflow** on the Actions tab. On main it also adds a missing tag.

A push to main that touches `package.json` without changing the version stops
at the tag step. So does any run before the Cloudflare secrets are set, and it
doesn't tag, so adding them and pressing **Run workflow** releases that version.
The release then runs three jobs in order:

1. **tag**: decides whether this run releases and adds the `vX.Y.Z` tag. It's
   the only job allowed to write to the repo.
2. **check**: `npm ci`, both typechecks and `npm test`. A failure here
   ships nothing.
3. **deploy**: builds the app first (so a broken build ships nothing), then
   `wrangler deploy`, then copies the Cloudflare TURN secrets to the Worker if
   you've set them. It runs in the `production` environment. Add required
   reviewers there (Settings → Environments) if you want an approval click
   before anything goes live.

What the repo needs set up in GitHub (Settings → Secrets and variables →
Actions). Make the Cloudflare ones **repository** secrets, since the tag job
checks for them and has no environment:

| Name | Kind | Needed | Used for |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | yes | `wrangler deploy`. Only given to the wrangler steps, never to `npm ci` or the build, where dependencies' own scripts run. A token from the "Edit Cloudflare Workers" template is enough. |
| `CLOUDFLARE_ACCOUNT_ID` | secret | yes | The same steps. |
| `VITE_PUBLIC_URL` | variable | no | Baked into the build. |
| `VITE_TURN_URLS` | variable | no | Your TURN server(s), baked into the build. |
| `VITE_TURN_USERNAME` | variable or secret | no | Its username. |
| `VITE_TURN_CREDENTIAL` | secret | no | Its credential. A secret keeps it out of the repo and the logs, but it still ends up readable in the shipped JavaScript. |
| `VITE_PEER_HOST`, `VITE_PEER_PORT`, `VITE_PEER_PATH`, `VITE_PEER_SECURE`, `VITE_PEER_KEY` | variables | no | A self-hosted PeerJS broker. |
| `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` | secrets | no | Cloudflare Realtime TURN key, copied to the Worker's secrets on each release so `/api/ice` can mint credentials. |

## Later

- **Log in with Discord.** Eventually you'll sign in with Discord and the app
  will take your username and avatar from there, instead of typing a name and
  getting a blobatar. Not started: for now it's a typed name and a blobatar.

## Project map

```
src/
  lib/          seats (planning + the animated Table), spring, room codes, prefs
  net/          protocol (+ validation), roomHost (holding the room id),
                session (joining, the call mesh, host hand-over), sdp, ICE config
  audio/        engine: mic, playback, panning, speaking detection
  components/   round table, call control buttons, settings, user menu, icons
  screens/      Home (make or join) and Room
  call.ts       the call as reactive state, and everything the UI can do to it
worker/         the Cloudflare Worker: static assets + /api/ice
scripts/        local PeerJS broker, e2e run
tests/          unit tests
```
