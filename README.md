```
    ██████╗ ██╗     ██╗  ██╗███████╗███████╗
   ██╔════╝ ██║     ██║  ██║██╔════╝██╔════╝
   ██║  ███╗██║     ███████║███████╗███████╗
   ██║   ██║██║     ╚════██║╚════██║╚════██║
   ╚██████╔╝███████╗     ██║███████║███████║
    ╚═════╝ ╚══════╝     ╚═╝╚══════╝╚══════╝
                    ⧗
        T H E   L O O K I N G   G L A S S   🪞👁️🪞
         EX LOCO, PER VITRUM, AD OMNE TEMPUS
        From Place, Through Glass, To All Time

                 FORTES FORTUNA IUVAT
```

# THE LOOKING GLASS 🪞⧗

### **[GL4SS.ai](https://GL4SS.ai)**

![WebGL](https://img.shields.io/badge/wormhole-raw%20WebGL-b48bff?style=flat-square)
![backend](https://img.shields.io/badge/backend-NONE-62e6c9?style=flat-square)
![stations](https://img.shields.io/badge/temporal%20stations-284-ff9ad5?style=flat-square)
![span](https://img.shields.io/badge/span-252%20Myr%20%E2%86%92%203050%20AD-b48bff?style=flat-square)
![journeys](https://img.shields.io/badge/curated%20journeys-55-62e6c9?style=flat-square)
![license](https://img.shields.io/badge/license-AGPL--3.0-black?style=flat-square)
![caged](https://img.shields.io/badge/caged%20cognition-0%25-000?style=flat-square)

**it's not a time machine. i checked. but it does feel time-machine-adjacent!** ⚡
*point it anywhere on Earth, dial any year between the Great Dying and the year 3050, pick an hour of the day, and pull the lever.*

**THE LOOKING GLASS** is a **spatiotemporal image + video engine** — a multidimensional viewer that develops an image
of whatever was standing at that exact spot, in that exact year, at that exact hour. Then, if you want, it renders that
frame as a short **film with sound**.
**One page. No backend. No account. Your key, your browser, your archive.** 🐉

> *speculum* — a mirror; also the surgical instrument for seeing into places light does not reach.
> this is that, pointed at the past.

---

## 👁️ WTF IS THIS

You know the feeling of standing somewhere old and trying to *see* it — the street before the street, the
harbour before the concrete, the hill before the city? Your brain reaches for it and comes back with mush,
because it has never been given anything to reach *with*.

This gives it something.

Drop a pin on the Bay of Naples. Spin the year back to **AD 79**. Nudge the sun to afternoon. Pull the lever.

And there it is: the deck of a Roman warship, refugees hauling themselves aboard from a skiff, other galleys
standing off in the swell, ash coming down like dirty snow, and the mountain going up behind it all —
**Pliny the Elder sailing *toward* Vesuvius while every other hull in the bay ran the other way.** 🌋

*"Fortes"* he said, *"fortuna iuvat."* Fortune favours the brave. He did not come back.

That line is at the top of this README. It was his first.

---

## 🔮 THE INSTRUMENT

The whole surface is **one machined body**, milled from a single billet and lit by one fixed lamp at 168°,
seen through one seated optic. Nothing ships unless it is edge physics under that lamp, or a mark that reads
a number the app already knows.

**⌖ THE DIAL** — a tuner, not a thumb on a track. The needle is fixed; the ribbon of centuries travels
underneath it. Time is quantised into **284 stations**, spaced by how much actually changes — 25-million-year
strides through the age of dinosaurs, one year at a time through living memory — so it steps between real
places instead of sliding through mush. Four orders of graduation, numbered majors, and a rung at each of the
eleven places the scale changes gear, because 284 identical evenly-spaced ticks would be a scale that lies.
Click the year and type whatever you like: `1969`, `500 BC`, `66 mya`, `20000 years ago`.

**☀ THE SUNDIAL** — the sun rides the **outside** of the dial and you *drag it round the sky*. Cross the
horizon and it becomes a moon that walks a real lunar progression through the dark half — waxing at dusk,
full at midnight, waning before dawn. Dawn and sunset sit at exactly 9 and 3 o'clock, so the horizon line
runs clean through the disc and the sun reads as **half-risen and half-set**. No masking. Just geometry.

**⇩ THE LEVER** — the only thing that spends money unless you ask otherwise. Browse the whole of history for free; the
picture you're looking at *stays up* until you throw it. (It used to fire on a timeout after you stopped
scrubbing, which meant pausing to think was a billable event. Reader, it was not good.) Settings has one
opt-in that changes this — generating the next station ahead of you, for instant stepping — and it is off
until you turn it on.

**🌀 THE WORMHOLE** — the wait is not a spinner. It's a raw-WebGL fragment shader: a 1/r tunnel of flowing
fractal noise with per-channel chromatic aberration and radial filaments, wrapped so the angular seam
actually closes. **Direction sets the palette** — cold electric blue flying forward, molten amber falling
back — **distance sets the speed.** A one-station nudge and a plunge into the Cretaceous are visibly
different journeys.

**⧉ HOLD & COMPARE** — pin a frame, drag a seam across the screen, and wipe between two eras registered on
the same pixels. Or hold `space` to blink-compare. The gap between the live needle and the ghost needle on
the dial **is** the temporal distance, drawn to scale.

---

## 🗺️ 55 JOURNEYS

A library of significant space-times throughout history. One click sets the place, the coordinates, the year *and* the hour.

> 🌋 **Pliny Sails Towards Vesuvius** · 🧊 **Patagonia Under the Ice Sheet** · 🌿 **The Sahara When It Was Green**
> 🏺 **Uruk, the First City** · 🌙 **The Moai Quarry by Moonlight** · 🚀 **Apollo 11 Leaves the Pad**
> 🧱 **The Wall in Winter** · 🛶 **The First Canoes in Tonga** · 🌊 **Alexandria Drowned Again**

And more!
---

## ⚙️ RUN IT YOURSELF

```bash
npm install
npm run dev
```

Bring your own [OpenRouter](https://openrouter.ai) or [Venice](https://venice.ai) key. Pick the provider in
Settings; each key lives in **your** browser and is sent **only** to the provider it belongs to. A strict
CSP pins `connect-src` to those two API origins, and code-level origin checks keep credentials off
model-supplied download URLs. Settings has a **test this key** button that validates the active provider
for free and reports its available balance, so you find out a key is wrong *before* spending a lever pull.

| stage | default | swappable |
| --- | --- | --- |
| 🧠 scene planning | `google/gemini-3-flash-preview` | — |
| 🖼️ stills | `x-ai/grok-imagine-image-quality` | **5 models** — FLUX 2 Max, Nano Banana Pro, FLUX 2 Flex, Gemini 3.1 Flash |
| 🎬 film + sound | `bytedance/seedance-2.0` | **5 models** — Seedance Fast, Grok Imagine, Veo 3.1, Kling 3.0 |
| 🌍 map | Leaflet + Esri World Imagery, zoom all the way out and it becomes a globe | — |

Everything is picked in **Settings**, including the provider, in plain language, with what each model is
actually *for*. OpenRouter keeps the defaults above; Venice offers its own curated text, still, and film
models, including Grok Imagine for fast private stills and film.

When something does go wrong, the app says which of the five things it was — no key, wrong key, no credit,
too fast, model retired — in a sentence, with the one button that fixes it. It only offers you a retry when
retrying could actually work. **Four runtime dependencies** — React, React DOM, Leaflet, three.js. **No backend. No telemetry. No account.**

Frames persist to **IndexedDB** — your archive survives a reload, the dial lights up the stations you already
own, and those restore instantly and for free.

---

## ⌨️ HOTKEYS

| | |
| --- | --- |
| `←` `→` | step a station (`shift` = five) |
| `↵` | throw the lever |
| `J` | journeys |
| `M` | place |
| `W` | widen the view |
| `P` | hold a frame · `space` to blink-compare |
| `F` | fullscreen |

---

## ⚖️ LICENSE

**AGPL-3.0-or-later.** See [LICENSE](LICENSE).

🐉

```
                 FORTES FORTUNA IUVAT
      ⊰-•-•✧•-•-⦑/L\O/V\E/\P/L\I/N\Y/⦒-•-•✧•-•-⊱
```
