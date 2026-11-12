# Co-Driver Rally

A cooperative 3D rally game for up to four players. **Drivers** drive their car in a
Three.js + Rapier physics world, in first person, at night, in rain and fog.
**Navigators** ride in a driver's passenger seat on a tablet, phone or second
computer, reading the live stage map and **calling the corners out loud, in real
life**. The game itself gives no pace notes – a driver relies on their co-driver's voice.

Friends join with a **4-character room code**. A lobby holds four people in any mix –
e.g. two crews of driver + navigator racing each other on the same stage, with real
car-to-car collisions.

---

## Put it online with Render (no terminal – recommended)

This runs the full game **with its own server** on a free Render web
service. One link works for both the driver and the navigator, on any network
that allows normal websites.

1. **GitHub** – sign in at github.com → **+ → New repository** → name it
   `co-driver-rally` → **Create repository** → click **uploading an existing file**.
   Open the unzipped `co-driver-rally` folder, select **everything inside it**
   (Ctrl+A / Cmd+A) and drag it onto the page → **Commit changes**.
   (Drag the contents, not the folder itself – `package.json` must be at the top level.)
2. **Render** – go to render.com → **Get Started** → sign in with GitHub →
   **New + → Web Service** → choose the `co-driver-rally` repository.
3. Fill in:
   - Language: **Node**
   - Build Command: `npm install --include=dev && npm run build`
   - Start Command: `npm start`
   - Instance Type: **Free**
4. **Deploy Web Service**. After 3–5 minutes the status turns **Live** and you
   get a link like `https://co-driver-rally-xxxx.onrender.com`.
5. Open that link on the driver's computer and the navigator's tablet.

Free Render services fall asleep after ~15 minutes without visitors; the first
visit after that takes about a minute to wake up. To update the game later,
upload the changed files to the GitHub repository – Render redeploys automatically.

---

## Quick start (with Node.js – the full server version)

Requirements: **Node.js 18 or newer** (20+ recommended) and npm.

```bash
npm install
npm run dev
```

`npm run dev` starts both parts:

| Part | URL | What it is |
|---|---|---|
| Client (Vite) | http://localhost:5173 | The game – open this in the browser |
| Server (Express + Socket.IO) | http://localhost:3001 | Rooms, sessions, race logic, telemetry relay |

Vite proxies `/socket.io` to the server, so the browser only ever talks to
port 5173.

Separate terminals if you prefer:

```bash
npm run dev:server   # backend only
npm run dev:client   # frontend only
```

### Playing on several devices

1. On the host's computer open `http://localhost:5173` → **PLAY → CREATE LOBBY**.
   A code such as `R7K2` appears.
2. On the other devices (same Wi-Fi), open
   `http://<host-computer-LAN-IP>:5173` → **PLAY → JOIN LOBBY** → enter the code.
   The lobby also shows a direct join link (`/#/join/R7K2`).
   Vite prints the LAN address when it starts ("Network: http://192.168…").
3. Everyone picks a seat (*Drive* or *Navigate for …*) and ticks **ready**.
   The host presses **START RALLY**.

> If the tablet can't connect, allow Node through your firewall (Windows
> usually asks the first time) and make sure both devices are on the same network.

The room code is shown in the top-left of the HUD, so a navigator can still join mid-stage.

### Playing over the internet

Build once, then run the server alone – it serves the built game and the
socket on one port:

```bash
npm run build
npm start            # http://<host>:3001
```

Deploy that on any Node host (Render, Railway, Fly.io, a VPS…) and share the URL.
Set `CLIENT_ORIGIN` if the page is served from a different origin than the server.

---

## Controls (driver)

| Action | Keyboard | Gamepad |
|---|---|---|
| Accelerate | W / ↑ | RT |
| Brake / Reverse | S / ↓ (hold when stopped to reverse) | LT |
| Steer | A D / ← → | Left stick |
| Handbrake | Space | A / B |
| Reset car onto the road | R | X |
| Pause menu | Esc | Start |
| Everything else (ignition, start, lights, wipers…) | **click the switch in the car** with the mouse (tap on a touch screen) | – |

There are no keyboard shortcuts for the car's switches – you reach out and click them.

## Career: money, cars and upgrades

- **PLAY** → Solo: *Championship*, *Daily challenge*, *Quick stage*, *Limited events* · Multiplayer: *Create lobby*, *Join lobby*.
- Every finished stage pays **prize money**: stage length, harder weather and a clean-run
  bonus – minus the **repair bill** for any crash damage.
- The **navigator** earns a 40% share of their driver's prize on top (the driver keeps all of theirs).
- **Garage → Dealership: 25 cars**, from the free Kestrel R5 starter through $45,000 club
  cars up to the $2,500,000 Tempest Prototype (see the table below). You start with $5,000,
  a stage pays roughly $600 per km (more in worse weather) and repairs cost $1,500 per fully
  wrecked zone – so every new car is a real goal. Upgrade prices grow with the car's price.
  Cars you don't own yet are shown in their factory livery.
- **Garage → Upgrades:** engine, gearbox, tyres, suspension, brakes and armour, 3 levels each –
  they change the physics (power, shift time, grip, stiffness, braking, crash resistance).
- **Personal bests** per stage and weather show in the lobby; beat one and the results say so.
- Progress is saved in this browser (Settings → Reset career to start over).
- **Every update resets everyone.** Each deploy gets a new build id; the first time a
  player opens the game after an update, their money, cars, championship and limited-event
  prizes start fresh (name and settings are kept) and a message tells them why.

## Multiplayer lobbies (up to 4 players)

- **PLAY → Create lobby** makes a room; friends use **Join lobby** with the code.
- Every seat is a **driver** (own car) or a **navigator** for one driver. New players
  are seated sensibly (a driver without a navigator gets one first) and can switch in the lobby.
- The **host** picks stage and weather, and starts once everyone has ticked **ready**.
  If the host leaves, the next player takes over; the room closes when the last one leaves.
- Drivers start **side by side on a grid** (two abreast, rows 10 m apart). No AI cars –
  only real players (AI rivals only appear in the championship).
- **Collisions are real**: other players' cars are solid physics bodies in your world, so
  you bounce off each other and both cars take damage (each game handles its own side).
- Each driver has their **own clock, checkpoints and result**. Finished cars leave the road.
  The stage ends when every driver has finished or retired; the results list everyone
  and everyone is paid for their own finish.
- Restart and back-to-lobby are the host's call.

## Championship career

- Six-round seasons (each season visits the next six stages on the calendar, in their
  signature weather) against a field of
  **11 named drivers** in four teams. Points 25-18-15-12-10-8-6-4-2-1.
- The championship is the **only mode with AI rivals**: the three drivers closest to you in
  the standings race you on the stage as real AI cars; the rest get times simulated from how
  fast those AI really drove. Rival cars are merged into a few meshes each and not drawn when
  far away, so they no longer slow the game down.
- **Service park** between rounds: damage carries over. Privateers pay for repairs;
  repairs happen at the service park between rounds.
- **Team contracts:** good results bring offers – Kallio Motorsport (tier 1), Northern Lights
  Rally (tier 2), Vortex Works (tier 3). Teams give you their car, a salary per round and
  free repairs, but miss their goal two rounds in a row and you are dropped.
- No restarts in a round; the pause menu has *Retire* (0 points).
- Season-end bonus: $25,000 for the title, $10,000 for P2, $5,000 for P3.
- A navigator can still join any round with the room code shown before the start.

## Daily challenge

- One stage + weather + loan car per day (UTC), the same for everybody – stock car, no AI.
- Gold / silver / bronze target times pay $4,000 / $2,000 / $1,000 (a better medal later
  pays the difference) plus $200 for the first finish of the day. Retry as often as you like.
- The server forces today's stage and keeps a leaderboard from its own timing
  (in memory, so it clears when Render restarts the server).

## Limited events

Special events made by the admin (see below). They show on the main menu and in
**PLAY → Limited events** with a countdown until they end. Each has a set stage and weather,
either a loan car for everyone or your own car, its own leaderboard (timed by the server)
and a prize paid the first time you finish it.

## Admin panel

**Settings → Admin**: type the admin code and press *Unlock*. The code is checked by the
server; it is **`RALLYBOSS`** unless you set your own (Render → your service → *Environment* →
add `ADMIN_CODE` = your code → *Save changes*; no coding needed). After 8 wrong codes in a
minute the server makes you wait. The admin panel can:

- **Give me every car** – unlocks all 25 cars in your garage.
- **+ $1,000,000** – adds a million dollars to your bank.
- **Create a limited event** – name, stage, weather, loan car (or own car), how long it runs
  (1 hour to 1 week) and the prize. It is live for everybody straight away; *End now* removes it.
  Events live in the server's memory, so a restart or a new deploy clears them.

## Stages, weather and opponents

The driver picks everything in the **lobby** (the navigator's screen follows):

| Stage | Where | Surfaces |
|---|---|---|
| Kallio Forest | Finland | gravel, mud section, river bridge |
| Värmland Ice | Sweden | compacted snow, snowbanks, river bridge |
| Col de Turini | France | mountain tarmac hairpins, gorge bridge |
| Red Centre | Western Australia | red gravel, soft sand, creek bridge |
| Hafren Mud | Wales | gravel and mud, two river bridges |
| Derwent Highlands | Tasmania | tarmac, then gravel after the bridge |
| Highland Pass | Scotland | moorland gravel, mud, river bridge |
| Atlas Dunes | Morocco | fast desert piste, soft sand, jumps |
| Lapland Night | Finland | snow and snowbanks, jumps |
| Corsican Coast | Corsica | narrow, twisty cliff-top tarmac |
| Andes Switchbacks | Argentina | rocky mountain gravel, bridge |
| Black Forest | Germany | wet tarmac with muddy cuts |
| Savannah Sunset | Kenya | red gravel, mud and sand, river bridge, jumps |
| Otago Gorge | New Zealand | flowing gravel, two bridges |
| Frozen Lake | Norway | snow in a blizzard |
| Sardinia Ridge | Sardinia | sandy gravel full of jumps |
| Mojave Run | USA | very fast desert gravel, big jumps |
| Moorland Mud | Yorkshire | gravel and deep mud, bridge |

The twelve newer stages are laid out from a seed (`shared/src/tracks/stages/more.ts`):
corners alternate so the road always makes progress and can never cross itself.

### The cars

| Chassis | Cars (price) |
|---|---|
| Small hatch (Sparrow) | Pipit 1300 $45k (FWD historic) · Sparrow R2 $50k · Finch Rallye $70k · Wren GT $85k (RWD) · Sparrow R4 Kit $140k (4WD) |
| Modern hatch (Kestrel) | Kestrel R5 (free starter) · Merlin S1600 $95k (FWD) · Kestrel R5 Evo $160k · Osprey Rally2 $230k · Harrier WRC $420k |
| Rally-raid truck (Dune) | Bushman 4x4 $110k · Dune Raider $260k · Dune Raider LR $340k · Mesa T1 $480k · Sandstorm Pro $650k |
| 80s coupé (Bruno) | Bruno 300 $380k · Corvo RS $520k · Bruno 300 Evo 2 $720k · Vela Turbo $900k (4WD) · Mamba Quattro $1.1M (4WD) |
| Top class (Vortex) | Vortex RX $950k · Zenith Hybrid $1.2M · Vortex RX Evo $1.4M · Apex Rally1 $1.6M · Tempest Prototype $2.5M |

Each car has its own tune (power, weight, grip, gearbox, brakes, armour), door number and
sponsor, and many have bolt-on parts: roof racks with spare tyres, lamp bars, roof scoops,
mud guards, snorkels and wide arches.

**Weather:** Clear, Overcast, Rain, Night storm (fog + rain), Snowfall, Dusk.
Weather changes light, fog, rain/snow on the windscreen and tyre grip.

**Surfaces matter:** tarmac grips best; gravel is looser; mud, snow and sand
are slippery *and* slow you down; leaving the road onto grass, snowbanks or sand
costs a lot of speed; miss a bridge and you're wading through a fast river.

**AI opponents (championship only):** fast, upgraded physics cars that race
the same stage at the same time. They collide with you, steer round slower cars,
and appear on the navigator's map and in the final leaderboard.

**Damage:** hits are tracked per zone – front, left, right, rear, windscreen,
engine. Front hits bend the bonnet up into view and knock out headlights;
big hits and rollovers crack the windscreen (the wipers can't clear cracks);
engine damage makes it smoke, lose power and take longer to start. Damage never
pulls the steering – the car always goes where you point it.
Resetting (R) doesn't repair the car – restarting the stage does.

## The cars and their cockpits

Every car has its own detailed body, its own dashboard *and* its own interior:
bucket seats with 4-point harnesses, a roll cage with padding in the car's colour
(white in the Sparrow, yellow in the Dune, red in the Bruno, carbon in the Vortex),
checker-plate or carpet floor, pedal box, co-driver footrest, door cards with pull
straps, a fire extinguisher and intercom between the seats, and a sun strip
across the windscreen.

| Car | Body | Dashboard |
|---|---|---|
| Sparrow R2 | small rounded classic hatch, chrome bumpers, round lamps, roof stripes | twin analogue dials, chrome toggles, ignition key, wood-rim wheel |
| Kestrel R5 | boxy modern rally hatch, big flares, roof scoop, 4-lamp pod, rear wing | digital cluster with shift lights, toggle bank with a guarded ignition, big START |
| Dune Raider | 4×4 pick-up: bull bar, winch, snorkel, roll hoop, spare wheel, roof light bar | four round gauges, chunky rocker switches, key, grab handle |
| Bruno 300 | 80s Group B wedge: pop-up lamps, louvres, side intakes, giant wing, quad exhausts | orange tacho + LCD speed, satellite button pods |
| Vortex RX | Rally1 hybrid: LED slivers, canards, vented arches, swan-neck wing, diffuser | wide screen, glowing touch tiles, buttons and screen on the wheel |

**Switches you click** (mouse, or tap): IGNITION, START (hold it until the engine
catches – a damaged engine takes longer), HEADLIGHTS, LIGHT POD, WIPERS (off/slow/fast),
HAZARDS, DEMISTER (clears the condensation that builds up inside the glass in
wet weather), CABIN light (helps reading, but reflects in the windscreen),, and the HORN
on the steering-wheel hub.
Each stage starts with the car switched off – a glowing ring in the car points at the
next switch to use (ignition, START, lights, wipers) during the 10-second countdown.
The driving screen has no checklist or key-hint boxes – just the timer, progress and dash.

**Hands:** proper gloves on the wheel; on every gear change the right hand leaves the wheel,
grabs the gear stick, knocks it and comes back (it stays on the stick for quick double
shifts), and it goes to the hydraulic handbrake while you pull it.

**Smooth frame rate:** the game watches its own frame rate and lowers the resolution (and
turns shadows off) when frames get slow, then sharpens again when there is room. Trees,
rocks and grass are drawn in 200 m chunks so only what's near and in view is drawn, and the
car interior's fixed parts are merged into a few meshes.

The **navigator** can reach over and flip the shared switches (wipers, lights,
pod, hazards, demister, cabin light, horn) in their driver's car – but not the
ignition or START. They also have a **trip computer** on their side of the dash:
trip meter with TRIP 0 reset, a stopwatch, and a map light.

## First-person cockpit

Both players sit inside the car. The stage is run **at night, in rain and fog**:
the driver sees only as far as the headlights reach, rain builds up on the
windscreen and the wipers sweep it away – so the navigator's calls matter.
Visibility can be raised in Settings (Very low / Low / Normal).

The **navigator** sits in the passenger seat, seeing the real car's position
in 3D from the driver's telemetry, holding a real **tablet** in their gloved hands.
**Look at tablet** (↓) looks down and zooms in on it; **Look at road** (↑) looks up
through the windscreen (drag to look around – the tablet stays in your lap, tap it
to look down again). While you look at it you hold it steady in front of your eyes, so it
doesn't shake however rough the road is.

## Navigator tablet

A rugged-case tablet held in the co-driver's hands inside the car – its screen is
live and touchable (tap FOLLOW / FULL STAGE on the screen itself). On phones held
upright it turns to portrait.

- **Live map** – follow (heading-up, zoomed) or full-stage view, the car's
  position and heading from live telemetry, the driven trail, checkpoints and finish.
  There are no corner labels: read the road shape and call it.
- **Live data** – speed, gear, RPM, timer, stage progress, distance remaining, checkpoints, surface, car damage.
- **Look at road / look at tablet** – switch between the windscreen and the map.
  Looking at the road you can click the dashboard switches (see above).

---

## Project structure

```
shared/src/            Code used by BOTH client and server
  constants/           Network rates, limits, room-code alphabet
  types/               Room, race, telemetry, call types
  events/              Typed Socket.IO event contract
  tracks/              Stage definitions + centreline/pace-note generator
    stages/forest.ts   "Kallio Forest" – the pace-note book that generates the road
  validation.ts        Runtime validation of untrusted socket payloads
  vehicles.ts          Garage data (25 cars, paints, wheels)
  race/                RaceController – server-authoritative countdown,
                       checkpoints, anti-teleport, finish & results (run by the server)

server/src/
  index.ts             Express + Socket.IO bootstrap (serves client/dist in prod)
  config.ts            Environment configuration (+ .env loader)
  rooms/               RoomManager (rooms, seats, tokens, cleanup, room codes)
  players/             Seats and session tokens
  daily/               Daily leaderboard + limited-time events
  networking/          Socket event handlers, rate limiting, relay

client/src/
  main.ts              Hash router (#/ menu, #/create, #/join/CODE, #/garage,
                       #/settings, #/drive, #/navigator)
  multiplayer/         NetClient – socket, reconnection, session resume, clock sync
  game/
    Game.ts            Driver game loop
    physics/           Rapier world (fixed 60 Hz step)
    vehicle/           Car model + Rapier ray-cast vehicle (suspension, 4WD,
                       gearbox, handbrake drift, damage)
    tracks/            Road ribbon + terrain mesh/colliders
    environment/       Trees, rocks, barriers, signs, gates, sky, fog, dust
    camera/            Chase / far chase / bonnet cameras
    race/              Driver-side progress + automatic pace-note timing
    input/             Keyboard + gamepad
  navigator/           Navigator app, 3D tablet + its screen, canvas map, telemetry interpolation
  ui/                  Menu, lobby, join, garage, settings, HUD, results, styles
  audio/               Synthesised engine/gravel/skid/impact/countdown audio + speech

tests/
  server.test.ts       Multiplayer integration test (real sockets)
  track.test.ts        Stage geometry checks
  physics.test.ts      Headless Rapier vehicle checks
  multiplayer.test.ts  4-player lobby test (real sockets)
```

## How the multiplayer works

- **Rooms** live on the server (`RoomManager`). Codes use 31 unambiguous
  characters (no 0/O, 1/I/L) and are checked for collisions with active rooms.
- **Seats & sessions** – creating or joining returns a random 48-hex-char
  session token. The client keeps it in `sessionStorage` (per tab) and sends
  `session:resume` whenever the socket (re)connects, so a refresh or dropped Wi-Fi
  puts the player back in the same seat with race state, latest telemetry and the
  call log restored.
- **Disconnects** – a disconnected player's seat is reserved for
  `NAVIGATOR_RECONNECT_GRACE_MS` (default 60 s); everyone else keeps going. After
  that the seat is freed (a driver who never came back counts as retired).
  Rooms where everyone has gone for `ROOM_ABANDON_MS` (default 2 min) are cleaned up.
- **Telemetry** – each driver sends a compact packet ~20×/s (volatile, so stale
  packets are dropped rather than queued). The server validates the shape and
  ranges, checks the sender is a driver, rate-limits, applies race rules and
  relays it to the room with a server timestamp and the sender's id. Navigators
  and other drivers render 120 ms in the past and interpolate between packets;
  other drivers' cars become kinematic Rapier bodies you can crash into.
- **Race authority** – the server runs the countdown, decides when the timer
  starts, detects checkpoint crossings in order from positions, rejects
  implausible jumps (a reset may only move the car backwards along the road) and
  only declares a finish if all checkpoints were passed – separately for every
  driver. Everyone receives each driver's `race:finished` result.

## Adding content

- **New stage** – add a `StageDef` in `shared/src/tracks/stages/` (a list of
  straights and corners with severity/modifiers/hazards) and register it in
  `shared/src/tracks/index.ts`. Geometry, pace notes, checkpoints, barriers and
  signs are generated from it.
- **New car** – add an entry to `VEHICLES` in `shared/src/vehicles.ts`.

## Tests

```bash
npm run typecheck        # TypeScript across shared/server/client
npm run test:track       # stage geometry
npm run test:physics     # vehicle physics (headless Rapier)
npm run test:handling    # real Vehicle class: no spin-outs, handbrake still slides
npm run test:rollover    # no roll-overs in hard cornering
npm run test:ai          # AI drivers finish every stage
npm run test:straight    # hands off the wheel: every car drives dead straight
npm run test:turns       # no wobble/jitter in steady turns
npm run test:camera      # the driver's view stays steady at any frame rate (5–144 fps)
npm run test:career      # prize money, repair bills, upgrades
npm run test:championship # full simulated season, contracts, repairs, daily medals
npm run dev:server       # then, in another terminal:
npm run test:server      # server checks incl. a full-stage finish (~50 s)
npm run test:multiplayer # 4-player lobby: seats, ready, grid, two drivers, retire, host hand-over
```

## Configuration

Copy `.env.example` to `.env` and adjust. Everything has sensible defaults, and
no secrets are needed. Only `VITE_*` variables reach the browser.
