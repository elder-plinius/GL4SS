/**
 * PORTAL — the v2 shell.
 *
 * Interaction contract, which is the actual redesign:
 *
 *  - The generated view is the entire screen. Nothing is docked over it that
 *    isn't needed to steer.
 *  - You hold a PLACE and travel through TIME. The dial is the primary control;
 *    the map is a puck you open only to change where you're standing.
 *  - Scrubbing is free, and so is settling. Dragging the dial moves through
 *    stations you already own and era light; landing on one you own restores it
 *    instantly. Landing on one you do NOT own arms the LEVER, and only throwing
 *    that lever spends money. Generation used to fire on a 480ms timeout after
 *    scrubbing stopped, which meant pausing to think was a billable event.
 *  - Once a station lands, its neighbours generate in the background, so
 *    stepping onward with the arrow keys is usually instant.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PortalView } from './components/PortalView';
import { TimeDial } from './components/TimeDial';
import { PlaceDial } from './components/PlaceDial';
import { Settings } from './components/Settings';
import { FilmWarning } from './components/FilmWarning';
import { LookPicker } from './components/LookPicker';
import { FilmControl } from './components/FilmControl';
import { TimeLever } from './components/TimeLever';
import { SunDial } from './components/SunDial';
import { JourneyGallery } from './components/JourneyGallery';
import type { Journey } from './lib/journeys';
import { SceneEngine, sceneKey } from './lib/engine';
import type { Scene, SceneStatus } from './lib/engine';
import { STATIONS, nearestStationIndex, neighbourStations } from './lib/stations';
import { eraAccent } from './lib/eraField';
import { jumpCharacter, makePin, openingSeam, pinApplies, pinnedSide } from './lib/pin';
import { safeStorage } from './lib/safeStorage';
import { DAY_PHASES, DEFAULT_PHASE_ID, findPhase } from './lib/daylight';
import type { JumpCharacter, Pin } from './lib/pin';
import type { Coordinates } from '../types';
import type { ModelSelection } from '../lib/openrouter';
import { defaultModelsFor, videoModelsFor } from '../lib/provider';
import type { ProviderId } from '../lib/provider';
import { STYLE_PRESETS, DEFAULT_STYLE_ID, findStyle } from '../lib/styles';
import {
  DEFAULT_IMAGE_TEMPLATE,
  LEGACY_IMAGE_TEMPLATES,
  PROMPT_TEMPLATE_STORAGE_KEY,
  validateTemplate,
} from '../lib/promptTemplate';
import { formatYear, getEraBand } from '../lib/format';

// Same storage keys as v1, so a key already saved there carries straight over.
const STORAGE_KEY_API = 'looking-glass-openrouter-key';
const STORAGE_KEY_MODELS = 'looking-glass-model-selection';
const STORAGE_KEY_PROVIDER = 'looking-glass-provider';
const STORAGE_KEY_VENICE_API = 'looking-glass-venice-key';
const STORAGE_KEY_VENICE_MODELS = 'looking-glass-venice-model-selection';
const STORAGE_KEY_STYLE = 'looking-glass-style';
const STORAGE_KEY_CUSTOM_STYLE = 'looking-glass-custom-style';
const STORAGE_KEY_FILM_WARNED = 'looking-glass-film-warned';
const STORAGE_KEY_PHASE = 'looking-glass-day-phase';
const STORAGE_KEY_PREFETCH = 'looking-glass-prefetch';

/** Clip lengths offered. Longer costs more and waits longer, linearly. */
const FILM_LENGTHS = [4, 8, 12] as const;

const DEFAULT_PLACE: Coordinates = { lat: 41.8902, lng: 12.4922 };
const DEFAULT_PLACE_NAME = 'The Colosseum, Rome';
const DEFAULT_YEAR = 120;

/** How long after you stop scrubbing before we look at what you have landed on. */
const SETTLE_MS = 480;

/**
 * Neighbours generated ahead of you, per direction. Was 2 (four frames) until a
 * live probe showed hero images cost 5.4–27.7s; four speculative frames could
 * take longer to land than a user takes to walk past them, and each one is a
 * real charge. 1 keeps the common case — arrow-stepping to the adjacent station
 * — instant, at two frames of speculation instead of four.
 */
const PREFETCH_RADIUS = 1;

/**
 * The portal overrides the shared wide-field default. v1 renders three panels
 * once per jump, so it can afford FLUX 2 Max at ~27.7s. The portal's premise is
 * that moving through time is fluid, and Grok Imagine measured 5.4s at close to
 * the same fidelity in side-by-side Colosseum frames — a 5x latency win is worth
 * more here than the last few percent of detail. This is the DEFAULT only —
 * Settings offers the full list, and a choice made there is remembered.
 */
const PORTAL_WIDE_FIELD_MODEL = 'x-ai/grok-imagine-image-quality';

function loadModels(provider: ProviderId): ModelSelection {
  const portalDefaults: ModelSelection =
    provider === 'openrouter'
      ? { ...defaultModelsFor(provider), wideField: PORTAL_WIDE_FIELD_MODEL }
      : defaultModelsFor(provider);
  try {
    const raw = safeStorage.get(
      provider === 'venice' ? STORAGE_KEY_VENICE_MODELS : STORAGE_KEY_MODELS,
    );
    if (!raw) return portalDefaults;
    const saved = JSON.parse(raw) as Partial<ModelSelection>;
    // wideField used to be forced back to the portal default here, to stop the
    // old v1 dashboard's model picker from silently reinstating a 28s model and
    // breaking the "stepping is instant" premise. That screen no longer ships,
    // and Settings now has its own picker — so a saved choice is a real choice
    // and is honoured. The fast model remains the DEFAULT, which was the part
    // that actually mattered.
    const merged = { ...portalDefaults, ...saved };
    const selectedVideo = videoModelsFor(provider).find((model) => model.id === merged.cinematic);
    // A curated provider list can drop a model when its supported durations no
    // longer match the portal. Do not leave a stale saved ID selected invisibly.
    if (!selectedVideo) {
      merged.cinematic = portalDefaults.cinematic;
      merged.cinematicText = portalDefaults.cinematicText;
      merged.animate = portalDefaults.animate;
      return merged;
    }
    // Older OpenRouter settings predate the text-only film fallback.
    if (!saved.cinematicText) merged.cinematicText = selectedVideo.textModelId ?? merged.cinematic;
    return merged;
  } catch {
    return portalDefaults;
  }
}

interface UrlState {
  lat?: number;
  lng?: number;
  year?: number;
  loc?: string;
  style?: string;
  phase?: string;
}

/**
 * Sanitise a place name arriving from outside the app.
 *
 * `loc` comes from the query string — i.e. from whoever wrote the link — and from
 * Nominatim, whose contents are editable by anyone with an OpenStreetMap account.
 * It then flows into the DOM and, more dangerously, verbatim into the prompt sent
 * on the *recipient's* API key. Unbounded and undelimited, a crafted link can
 * rewrite the scene contract and steer someone else's account into moderation
 * flags. Strip markup and control characters, collapse whitespace, and cap the
 * length so it cannot carry instructions.
 */
function sanitizePlaceName(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/[<>]/g, '')
    // Newlines are how injected text escapes its clause and starts a new one.
    .replace(/[\r\n\t]+/g, ' ')
    // Escapes, not literal bytes: an earlier edit wrote the raw control
    // characters into the source, which made this a BINARY file to git,
    // grep and every diff tool. It matched correctly and was invisible.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    // Quotes, backticks and braces are how injected text closes the clause it is
    // sitting in, or opens a fake one. The planner also receives this JSON-quoted
    // now, so these are two independent guards rather than one.
    .replace(/["'`{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // 120 was generous, and generous is the wrong instinct for a value that
    // reaches a prompt. Real place names fit comfortably in 80.
    .slice(0, 80);
  return cleaned.length ? cleaned : undefined;
}

/** Latitude/longitude must be real and in range, or the whole app is nonsense. */
function validCoord(n: number | undefined, limit: number): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  return Math.abs(n) <= limit ? n : undefined;
}

function readUrl(): UrlState {
  const p = new URLSearchParams(window.location.search);
  const num = (k: string): number | undefined => {
    const v = p.get(k);
    if (v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const style = p.get('style');
  const phase = p.get('phase');
  return {
    // Validated against the ladder, not trusted: an unknown id would otherwise
    // be persisted and then silently change every cache key from a bad link.
    phase: DAY_PHASES.some((d) => d.id === phase) ? (phase ?? undefined) : undefined,
    lat: validCoord(num('lat'), 90),
    lng: validCoord(num('lng'), 180),
    year: num('year'),
    loc: sanitizePlaceName(p.get('loc')),
    // An unrecognised style id would be persisted to storage and would leave the
    // style radiogroup with zero tab stops, since nothing matches to be tabbable.
    style: STYLE_PRESETS.some((s) => s.id === style) ? (style ?? undefined) : undefined,
  };
}

export function Portal() {
  // Lazy useState rather than a ref: this is init-once derived state, and
  // reading a ref during render is exactly what it isn't for.
  const [initialUrl] = useState(readUrl);

  const [provider, setProvider] = useState<ProviderId>(() =>
    safeStorage.get(STORAGE_KEY_PROVIDER) === 'venice' ? 'venice' : 'openrouter',
  );
  const [apiKeys, setApiKeys] = useState<Record<ProviderId, string>>(() => ({
    openrouter: safeStorage.get(STORAGE_KEY_API) ?? '',
    venice: safeStorage.get(STORAGE_KEY_VENICE_API) ?? '',
  }));
  const [modelsByProvider, setModelsByProvider] = useState<Record<ProviderId, ModelSelection>>(
    () => ({
      openrouter: loadModels('openrouter'),
      venice: loadModels('venice'),
    }),
  );
  const apiKey = apiKeys[provider];
  const models = modelsByProvider[provider];
  const changeModels = useCallback((next: ModelSelection) => {
    setModelsByProvider((current) => ({ ...current, [provider]: next }));
    safeStorage.set(
      provider === 'venice' ? STORAGE_KEY_VENICE_MODELS : STORAGE_KEY_MODELS,
      JSON.stringify(next),
    );
  }, [provider]);
  const changeProvider = useCallback((next: ProviderId) => {
    setProvider(next);
    safeStorage.set(STORAGE_KEY_PROVIDER, next);
  }, []);
  const [styleId, setStyleId] = useState(
    () => initialUrl.style ?? safeStorage.get(STORAGE_KEY_STYLE) ?? DEFAULT_STYLE_ID,
  );

  const [coordinates, setCoordinates] = useState<Coordinates>(() =>
    initialUrl.lat !== undefined && initialUrl.lng !== undefined
      ? { lat: initialUrl.lat, lng: initialUrl.lng }
      : DEFAULT_PLACE,
  );
  const [location, setLocation] = useState(() => initialUrl.loc ?? DEFAULT_PLACE_NAME);
  /**
   * Station index and how we got here, as ONE piece of state.
   *
   * The jump's direction and distance are a property of the *transition*, so
   * deriving them needs the previous index. Keeping that in a ref meant reading
   * a ref during render; recording it in an effect meant setState-in-effect.
   * Folding both into a single value makes the update pure: the reducer already
   * has the old index in hand.
   */
  const [nav, setNav] = useState<{
    index: number;
    /** Where the current journey began; null once it has been consumed. */
    origin: number | null;
    jump: JumpCharacter | null;
  }>(() => ({
    index: nearestStationIndex(initialUrl.year ?? DEFAULT_YEAR),
    origin: null,
    jump: null,
  }));
  const index = nav.index;
  const jump = nav.jump;

  /**
   * A TYPED YEAR IS EXACT.
   *
   * The ladder is what makes the cache work, and scrubbing and stepping should
   * keep landing on its rungs. But typing "2077" is not browsing — it is a
   * request for a specific year, and snapping it to 2075 answers a question
   * nobody asked. Worse, it was silent: the caption then said 2075 and the image
   * model was told 2075, so the frame really was the wrong year.
   *
   * So an exact year rides ALONGSIDE the index rather than replacing it. The
   * index still says which rung we are nearest — the dial needs it for the
   * ribbon and the neighbours — while this is the year everything downstream
   * actually uses. Any move along the ladder clears it (see setIndex), so the
   * exception cannot leak into ordinary navigation.
   */
  const [exactYear, setExactYear] = useState<number | null>(() => {
    const y = initialUrl.year;
    if (y === undefined) return null;
    return STATIONS.includes(y) ? null : y;
  });

  /**
   * Moving records where the journey STARTED, not the size of the last step.
   *
   * The character was computed per setIndex call, so twelve rapid Shift+Left
   * presses read as twelve separate five-station hops — every one of them
   * "near" — and a sixty-station plunge into the Neogene got the same gentle
   * drift as nudging one decade. `origin` is pinned at the first move away from
   * a settled frame and only released when a new one is generated, so the warp
   * describes the trip actually taken.
   */
  const setIndex = useCallback((next: number | ((current: number) => number)) => {
    // Stepping or scrubbing is ladder navigation, so it ends any exact year the
    // user typed. Done here, at the single choke point every move goes through,
    // rather than at each call site where one would eventually be forgotten.
    setExactYear(null);
    setNav((cur) => {
      const target = typeof next === 'function' ? next(cur.index) : next;
      if (target === cur.index) return cur;
      const origin = cur.origin ?? cur.index;
      return { index: target, origin, jump: jumpCharacter(origin, target) ?? cur.jump };
    });
  }, []);

  const [pin, setPin] = useState<Pin | null>(null);
  const [seamDrag, setSeamDrag] = useState<{ pairing: string; value: number } | null>(null);
  const [peeking, setPeeking] = useState(false);
  const [pinNotice, setPinNotice] = useState<string | null>(null);

  const [scrubbing, setScrubbing] = useState(false);
  const [mapExpanded, setMapExpanded] = useState(false);

  /**
   * On a narrow layout the place panel stretches edge to edge and sits ON TOP of
   * the dials and the lever. The lever underneath stayed armed, so Tab-then-Enter
   * — or just Enter, which the global handler routes to the lever — spent money
   * on a control the user could not see, while they were still choosing WHERE to
   * point the thing. The generated frame was for the old place.
   *
   * matchMedia rather than a resize listener: it fires only when the breakpoint
   * is actually crossed, and it agrees with the stylesheet by construction —
   * 700px is the same number the `@media` block uses.
   */
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 700px)');
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  /** True exactly when the place panel is drawn over the money lever. */
  const placeCoversLever = narrow && mapExpanded;
  const [keyGateOpen, setKeyGateOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  /** Free-text modifier behind the CUSTOM chip. */
  const [customStyle, setCustomStyle] = useState(
    () => safeStorage.get(STORAGE_KEY_CUSTOM_STYLE) ?? '',
  );
  const [filmSeconds, setFilmSeconds] = useState<number>(8);
  const [filmWarnPending, setFilmWarnPending] = useState(false);
  const [lookOpen, setLookOpen] = useState(false);
  /** Whether the panorama is showing. Separate from wideStatus so the frames can
   *  be kept once paid for and toggled without re-generating. */
  /**
   * Time of day. MIDDAY BY DEFAULT — and the default is load-bearing, not a
   * preference: sceneKey omits the phase when it is midday, so every frame
   * generated before the sundial existed keeps its key and stays in the archive.
   */
  const [phaseId, setPhaseId] = useState(
    () => findPhase(initialUrl.phase ?? safeStorage.get(STORAGE_KEY_PHASE) ?? DEFAULT_PHASE_ID).id,
  );

  const [widened, setWidened] = useState(false);

  useEffect(() => {
    safeStorage.set(STORAGE_KEY_PHASE, phaseId);
  }, [phaseId]);

  /**
   * IMMERSIVE. Every control retracts and the photograph is the only thing left.
   *
   * Two things at once, on purpose: the chrome hides (a CSS state) AND the
   * browser goes fullscreen (a platform call). Either alone is half the feature —
   * hiding the chrome still leaves a browser frame around a "fullscreen" view,
   * and requesting fullscreen alone just makes the same UI bigger.
   *
   * requestFullscreen must be called from a user gesture, which both the key
   * handler and the button satisfy. It is also allowed to reject — iOS Safari has
   * no element fullscreen at all — so the chrome-hiding half never depends on it.
   */
  const [immersive, setImmersive] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);

  /**
   * SPECULATIVE PREFETCH, OFF BY DEFAULT.
   *
   * It generates the two neighbouring stations so arrow-stepping is instant —
   * genuinely nice, and genuinely NOT free: each neighbour is a full text call
   * plus a full image call, billed to the visitor's own key.
   *
   * It used to be unconditional, gated only on the current scene being 'ready'.
   * A scene reaches 'ready' by being RESTORED FROM DISK as well as by being
   * generated, so a returning visitor opened the tab, touched nothing, and was
   * billed for two frames within a second — while this app's entire stated
   * contract is that the lever is the only thing that spends. Defaulting it off
   * makes that sentence true again; anyone who wants the speed can opt in, and
   * now knows what they are opting into.
   */
  const [prefetchEnabled, setPrefetchEnabled] = useState(
    () => safeStorage.get(STORAGE_KEY_PREFETCH) === '1',
  );

  useEffect(() => {
    safeStorage.set(STORAGE_KEY_PREFETCH, prefetchEnabled ? '1' : '0');
  }, [prefetchEnabled]);
  /** The image meta-prompt, user-editable. */
  const [template, setTemplate] = useState(
    () => {
      // MIGRATION. The effect below persists the template on MOUNT, so the
      // default live at a user's first ever load was written to storage even if
      // they never opened Settings. Read back naively, that pins 100% of
      // returning users to an old default forever, and any change to
      // DEFAULT_IMAGE_TEMPLATE reaches nobody — including {habitation} and
      // {period}, without which the image half of this fix is dead code. A
      // stored string byte-equal to a previous default was never edited by a
      // human, so replacing it is safe; anything else is the user's own text.
      const stored = safeStorage.get(PROMPT_TEMPLATE_STORAGE_KEY);
      if (!stored || LEGACY_IMAGE_TEMPLATES.includes(stored)) return DEFAULT_IMAGE_TEMPLATE;
      return stored;
    },
  );

  /* The exact year wins when there is one; otherwise the rung we are on. This
     single line is what the caption, the scene key, the prompt and the archive
     all read, so there is no path by which the UI and the image model can
     disagree about which year is being generated. */
  const year = exactYear ?? STATIONS[index]!;
  const accent = eraAccent(year);

  /**
   * Only a VALID template is persisted or used.
   *
   * validateTemplate was advisory: the editor showed the error while the broken
   * text was still saved on every keystroke and fed to the models. Clearing the
   * box produced subject-less prompts silently, and the damage survived reloads.
   * The editor keeps showing you what you typed; the app keeps using the last
   * thing that actually works.
   */
  const templateIsValid = validateTemplate(template) === null;
  const effectiveTemplate = templateIsValid ? template : DEFAULT_IMAGE_TEMPLATE;

  /**
   * Cache identity for the current look.
   *
   * sceneKey() keys on styleId, but the CUSTOM chip's look is free text — two
   * different custom modifiers would share the id "custom" and therefore share
   * cached frames, so editing the text would silently serve the old picture.
   * Folding a cheap hash of the text into the id keeps every distinct look its
   * own cache namespace.
   */
  const styleKey = useMemo(() => {
    const hash = (text: string) => {
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
      return (h >>> 0).toString(36);
    };
    const preset = findStyle(styleId);
    const base = preset.isCustom
      ? customStyle.trim()
        ? `custom:${hash(customStyle)}`
        : DEFAULT_STYLE_ID
      : styleId;
    // A custom meta-prompt changes every pixel, so it belongs in the cache key
    // exactly as much as the style does. Without it, editing the template served
    // back frames produced by the previous prompt — and persisted them as though
    // they were the new one.
    return effectiveTemplate === DEFAULT_IMAGE_TEMPLATE
      ? base
      : `${base}+t${hash(effectiveTemplate)}`;
  }, [styleId, customStyle, effectiveTemplate]);


  // --- engine --------------------------------------------------------------
  // Constructed empty and configured in the effect below, which runs before
  // any request can fire (the demand effect is declared after this one and is
  // debounced on top of that).
  const [engine] = useState(
    () => new SceneEngine({ provider: 'openrouter', apiKey: '', models: defaultModelsFor('openrouter') }),
  );

  useEffect(() => {
    engine.setConfig({ provider, apiKey, models });
  }, [engine, provider, apiKey, models]);

  const scenes = useSyncExternalStore(engine.subscribe, engine.getSnapshot);

  const currentKey = useMemo(
    () => sceneKey({ year, coordinates, location, styleId: styleKey, phaseId }),
    [year, coordinates, location, styleKey, phaseId],
  );
  const scene = useMemo(() => scenes.find((s) => s.key === currentKey), [scenes, currentKey]);

  /**
   * THE FRAME ON SCREEN, which is not the same thing as the station on the dial.
   *
   * Tuning the dial changes where you are AIMED. It must not change what you are
   * LOOKING AT — browsing is free, and a viewport that empties itself every time
   * you move one station punishes the exact exploration the lever was built to
   * make safe. So the last frame you actually landed on stays up until a new one
   * arrives.
   *
   * This deliberately reintroduces the situation PortalView's staleness guard was
   * written to prevent — a photograph of one year on screen while the UI names
   * another — so the fix has to come from the other side: everything that
   * DESCRIBES the picture (place, year, era, prose) now reads off `displayed`,
   * and only the dial and the lever read off the station. The dial is the
   * destination; the viewport is the present. The lever is what joins them.
   */
  const [displayed, setDisplayed] = useState<Scene | null>(null);
  const [seenScene, setSeenScene] = useState<Scene | undefined>(undefined);
  // Adjusted during render rather than in an effect. This is the same rule
  // React documents for state derived from a changed prop: an effect would
  // paint the OLD frame first and correct it on a second commit, which is a
  // visible flash on exactly the transition this variable exists to smooth.
  // Comparing the scene OBJECT, not its key, so later patches to the same
  // station — a film url, a widened panorama — still reach the screen.
  if (scene !== seenScene) {
    setSeenScene(scene);
    if (scene?.status === 'ready') setDisplayed(scene);
  }


  /** Cache state per year, restricted to the place + style we're actually on. */
  const statusByYear = useMemo(() => {
    const map = new Map<number, SceneStatus>();
    const lat = coordinates.lat.toFixed(3);
    const lng = coordinates.lng.toFixed(3);
    // Stations we hold on disk read as ready even before anything loads them —
    // the dial should show what you OWN, not merely what is in memory this
    // session. Without this, a reload would present a timeline you had already
    // paid for as though it were empty.
    for (const stationYear of STATIONS) {
      if (engine.hasStored({ year: stationYear, coordinates, location, styleId: styleKey, phaseId })) {
        map.set(stationYear, 'ready');
      }
    }
    for (const s of scenes) {
      if (s.styleId !== styleKey) continue;
      // The hour is part of a scene's identity, so a frame owned at midnight
      // must not light the dial's dot while the sundial is set to midday.
      if (findPhase(s.phaseId).id !== phaseId) continue;
      if (s.coordinates.lat.toFixed(3) !== lat || s.coordinates.lng.toFixed(3) !== lng) continue;
      map.set(s.year, s.status);
    }
    return map;
  }, [scenes, coordinates, styleKey, engine, location, phaseId]);

  // --- demand: generate what the user settled on ---------------------------
  useEffect(() => {
    if (!apiKey || scrubbing) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      // Never spend money before we know what we already own. Without this the
      // first station after a reload was regenerated against an empty index and
      // then overwrote the frame we already had on disk.
      await engine.whenHydrated();
      if (cancelled) return;

      const here = { year, coordinates, location, styleId: styleKey, phaseId };
      // Exempt `here`: it is very often the station we were already prefetching,
      // and aborting it discarded work the visitor had already paid for.
      engine.cancelPrefetch(here);
      // Drop demand work for wherever we used to be — there is only one place
      // the user is looking, and it should never queue behind an abandoned one.
      engine.supersedeDemand(here);

      // Only take what is already ours. A station we own restores instantly and
      // for free; anything else waits for the lever. Settling used to generate on
      // a TIMEOUT, which meant pausing to think was billable.
      const owned = engine.hasStored(here) || engine.peek(here) !== undefined;
      if (owned) engine.request(here, 'demand');
    }, SETTLE_MS);
    return () => {
      // The await above means this effect can outlive its own cleanup; without
      // the flag, moving on during hydration would still fire a demand for the
      // station we have already left.
      cancelled = true;
      clearTimeout(t);
    };
  }, [engine, apiKey, scrubbing, year, coordinates, location, styleKey, phaseId]);

  // --- speculation: once we've landed, prepare the neighbours --------------
  useEffect(() => {
    if (!prefetchEnabled) return;
    if (!apiKey || scrubbing) return;
    if (scene?.status !== 'ready') return;
    const t = setTimeout(() => {
      for (const neighbourYear of neighbourStations(index, PREFETCH_RADIUS)) {
        engine.request({ year: neighbourYear, coordinates, location, styleId: styleKey, phaseId }, 'prefetch');
      }
    }, 400);
    return () => clearTimeout(t);
  }, [engine, apiKey, scrubbing, scene?.status, index, coordinates, location, styleKey, phaseId, prefetchEnabled]);

  // --- url sync ------------------------------------------------------------
  useEffect(() => {
    const p = new URLSearchParams();
    p.set('lat', coordinates.lat.toFixed(4));
    p.set('lng', coordinates.lng.toFixed(4));
    p.set('year', String(year));
    p.set('loc', location);
    if (styleId !== DEFAULT_STYLE_ID) p.set('style', styleId);
    // Omitted at the default, exactly as the style is and for the same reason as
    // sceneKey: a link to a midday frame should be the link it has always been,
    // and the parameter should only appear when it is carrying information.
    // Without this a shared journey lost its hour — the sundial is part of the
    // destination, not a local preference.
    if (phaseId !== DEFAULT_PHASE_ID) p.set('phase', phaseId);
    window.history.replaceState(null, '', `${window.location.pathname}?${p.toString()}`);
  }, [coordinates, year, location, styleId, phaseId]);

  useEffect(() => {
    safeStorage.set(STORAGE_KEY_STYLE, styleId);
  }, [styleId]);

  useEffect(() => {
    safeStorage.set(STORAGE_KEY_CUSTOM_STYLE, customStyle);
  }, [customStyle]);

  useEffect(() => {
    // Persist only a template that DIFFERS from the shipped default. Writing the
    // pristine default on mount is what created the migration problem above, and
    // leaving it would recreate it for the next default change. Storage now holds
    // only genuine user edits; an absent key means "use whatever ships".
    if (!templateIsValid) return;
    if (template === DEFAULT_IMAGE_TEMPLATE) {
      safeStorage.remove(PROMPT_TEMPLATE_STORAGE_KEY);
      return;
    }
    safeStorage.set(PROMPT_TEMPLATE_STORAGE_KEY, template);
  }, [template, templateIsValid]);

  // The custom chip's suffix is whatever the user wrote; every other chip uses
  // its own. Threaded into the engine so a style change re-keys the cache.
  useEffect(() => {
    const preset = findStyle(styleId);
    engine.setStyleOverride(
      preset.isCustom ? (customStyle.trim() || null) : preset.suffix,
      effectiveTemplate,
    );
  }, [engine, styleId, customStyle, effectiveTemplate]);

  // --- input ---------------------------------------------------------------
  const step = useCallback(
    (delta: number) => {
      setIndex((i) => Math.max(0, Math.min(STATIONS.length - 1, i + delta)));
    },
    [setIndex],
  );

  const pickPlace = useCallback((next: Coordinates, name: string) => {
    setCoordinates(next);
    // Nominatim results are user-editable OpenStreetMap content and reach the
    // prompt, so they get the same treatment as a URL param.
    setLocation(sanitizePlaceName(name) ?? `${next.lat.toFixed(3)}, ${next.lng.toFixed(3)}`);
  }, []);

  /**
   * Take a curated journey: place, coordinates, year and hour, all at once.
   *
   * Deliberately does NOT generate. It tunes the instrument and closes, leaving
   * the lever armed — browsing is free, and a gallery that spent money on every
   * click would be a trap. The journey's year is guaranteed to be a station (see
   * journeys.ts), so nearestStationIndex is an exact lookup here rather than a
   * snap, and the destination is the one the card named.
   */
  const takeJourney = useCallback(
    (j: Journey) => {
      setCoordinates({ lat: j.lat, lng: j.lng });
      setLocation(sanitizePlaceName(j.location) ?? j.location);
      setPhaseId(findPhase(j.phaseId).id);
      setIndex(nearestStationIndex(j.year));
      setGalleryOpen(false);
      // A journey is a fresh departure, not a continuation of whatever sweep the
      // user was mid-way through: the wormhole's direction and distance should
      // describe THIS jump.
      setNav((cur) => ({ ...cur, origin: null }));
    },
    [setIndex],
  );

  /** Start a film, showing the one-time warning first if it is still due. */
  const requestFilm = useCallback(() => {
    if (!scene || scene.status !== 'ready') return;
    if (safeStorage.get(STORAGE_KEY_FILM_WARNED) === '1') {
      void engine.filmize(scene.key, filmSeconds);
      return;
    }
    setFilmWarnPending(true);
  }, [engine, scene, filmSeconds]);

  const confirmFilm = useCallback(
    (dontShowAgain: boolean) => {
      setFilmWarnPending(false);
      if (dontShowAgain) safeStorage.set(STORAGE_KEY_FILM_WARNED, '1');
      if (scene?.status === 'ready') void engine.filmize(scene.key, filmSeconds);
    },
    [engine, scene, filmSeconds],
  );

  /** Throw the lever: this is the only path that starts a paid generation. */
  const pullLever = useCallback(async () => {
    // Disarming the button is not enough on its own: the global key handler
    // routes Enter straight here, so a covered lever was still one keystroke
    // away. Both doors have to be shut, and this is the one that matters.
    if (placeCoversLever) return;
    if (!apiKey) {
      setKeyGateOpen(true);
      return;
    }
    /**
     * Never spend before we know what is already on disk. The settle effect
     * already awaits this (see the demand effect); the LEVER did not, so a pull
     * during the first moments after load could regenerate — and then overwrite
     * — a frame the visitor had already paid for in an earlier session.
     */
    await engine.whenHydrated();
    const here = { year, coordinates, location, styleId: styleKey, phaseId };
    /**
     * A failed station needs retry(), not request(). request() finds the existing
     * scene, touches it and returns it unchanged — so a lever that arms on error
     * (which it now does, because going dead at the one moment you want to try
     * again is the wrong behaviour) would visibly arm and then do nothing at all.
     * retry() aborts anything still in flight and drops the scene so it rebuilds.
     */
    if (scene?.status === 'error') engine.retry(here);
    else engine.request(here, 'demand');
    // The journey is spent; the next move starts a new one from here.
    setNav((cur) => ({ ...cur, origin: null }));
  }, [engine, apiKey, year, coordinates, location, styleKey, phaseId, scene?.status, placeCoversLever]);

  const handleFrameError = useCallback(
    (key: string, message: string) => engine.markFrameError(key, message),
    [engine],
  );

  // ---- the pin ------------------------------------------------------------
  // A pin belongs to one place and one style. Rather than clearing it from an
  // effect when those change (a cascading render, and a race with the scene it
  // points at), a stale pin simply stops being *active* — derived, not synced.
  const rawPinnedYear = pin ? STATIONS[pin.index] : undefined;
  const rawPinnedScene = useMemo(() => {
    if (!pin || rawPinnedYear === undefined) return undefined;
    if (!pinApplies(pin, coordinates, styleKey)) return undefined;
    const key = sceneKey({ year: rawPinnedYear, coordinates, location, styleId: styleKey, phaseId });
    return scenes.find((s) => s.key === key);
  }, [pin, rawPinnedYear, scenes, coordinates, location, styleKey, phaseId]);

  const activePin =
    pin && pinApplies(pin, coordinates, styleKey) && rawPinnedScene?.status !== 'error'
      ? pin
      : null;
  const pinnedYear = activePin ? STATIONS[activePin.index] : undefined;
  const pinnedScene = activePin ? rawPinnedScene : undefined;

  /** A comparison is live only when the pin is elsewhere and its frame exists. */
  const comparing =
    Boolean(activePin) &&
    activePin!.index !== index &&
    pinnedScene?.status === 'ready' &&
    !scrubbing;

  const togglePin = useCallback(() => {
    if (pin && pin.index === index) {
      setPin(null);
      return;
    }
    // Only ever hold something already owned. This is what makes the whole
    // feature incapable of producing a surprise bill — there is no path from a
    // comparison gesture to a generation call.
    const owned =
      scene?.status === 'ready' || engine.hasStored({ year, coordinates, location, styleId: styleKey, phaseId });
    if (!owned) {
      setPinNotice('nothing to hold at this station');
      return;
    }
    setPin(makePin(index, coordinates, styleKey));
    setPinNotice(null);
  }, [pin, index, scene, engine, year, coordinates, location, styleKey, phaseId]);

  /**
   * Seam position, derived per pairing.
   *
   * A comparison opens at a distance-derived position — a two-station hop as a
   * sliver of the past intruding, a forty-station leap near the middle as a real
   * confrontation. Dragging overrides it, but only for that pairing: move either
   * needle and the next comparison opens at its own natural width again. Storing
   * the drag WITH its pairing means no effect has to reset it.
   */
  const pairing = activePin ? `${activePin.index}:${index}` : '';
  const seam =
    seamDrag && seamDrag.pairing === pairing
      ? seamDrag.value
      : activePin
        ? openingSeam(activePin, index, STATIONS.length)
        : 0.5;
  const setSeam = useCallback(
    (value: number) => setSeamDrag({ pairing, value }),
    [pairing],
  );

  // Clear a transient notice.
  useEffect(() => {
    if (!pinNotice) return;
    const t = setTimeout(() => setPinNotice(null), 1600);
    return () => clearTimeout(t);
  }, [pinNotice]);

  const toggleImmersive = useCallback(() => {
    const next = !immersive;
    setImmersive(next);
    /**
     * The platform call sits OUTSIDE the state updater, and deliberately.
     * Inside it, two things went wrong: StrictMode double-invokes updaters, so
     * the fullscreen request fired twice per press; and requestFullscreen throws
     * SYNCHRONOUSLY when the browser declines, which aborted the updater and
     * left the toggle doing nothing at all — the button appeared inert.
     *
     * Out here, the chrome-hiding half is already committed before the platform
     * is asked for anything, so a refusal degrades to "hides the UI" instead of
     * "does nothing".
     */
    try {
      if (next) void document.documentElement.requestFullscreen?.()?.catch(() => {});
      else if (document.fullscreenElement) void document.exitFullscreen?.()?.catch(() => {});
    } catch {
      /* No element fullscreen here (iOS Safari, embedded frames). Fine. */
    }
  }, [immersive]);

  /**
   * The browser owns fullscreen, not us: Escape, F11 and the OS chrome can all
   * leave it without telling React. Without this listener the app would sit in
   * immersive mode with its controls hidden and no visible way back.
   */
  useEffect(() => {
    const sync = () => {
      if (!document.fullscreenElement) setImmersive(false);
    };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  // An undecodable held frame is handled by `activePin` above rather than an
  // effect: the pin object survives but stops being active, the seam closes, and
  // nothing cascades.

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        if (e.key === 'Escape') el.blur();
        return;
      }
      // While the key dialog is up, the app behind it is not operable. Arrows
      // used to keep retuning time behind the modal — changing state the user
      // could not see and, with a key already saved, spending money to do it.
      // Escape still reaches the handler below so the dialog can be dismissed.
      if (keyGateOpen && e.key !== 'Escape') return;
      /**
       * The film-cost dialog is a CONSENT dialog — it exists to ask before
       * spending minutes and money. The global handler stayed live behind it, so
       * W fired a paid widen from inside the consent prompt and the arrows
       * retargeted which station the pending film would be rendered from. A
       * dialog whose whole purpose is "are you sure" must not let the app act
       * while it is open.
       */
      if (filmWarnPending && e.key !== 'Escape') return;
      // The gallery is a modal on top of everything and owns its own keys; its
      // Escape is handled and stopped inside the component.
      if (galleryOpen) return;

      /**
       * ENTER AND SPACE BELONG TO WHATEVER HAS FOCUS.
       *
       * This handler is on `window` and only exempted INPUT/TEXTAREA, so with a
       * button focused it called preventDefault() on Enter and ran pullLever():
       * the button never activated, and with a key saved that keystroke fired a
       * BILLED generation instead. Every control in the chrome was affected —
       * journeys, fullscreen, the key dialog, the caption CTAs, the film render
       * button, the style radios. Space was the same during a comparison, which
       * left no activation key at all.
       *
       * Only the activation keys are scoped. The arrows stay global on purpose:
       * the dial is the app's primary control and Left/Right must step it
       * wherever focus happens to be, including while the dial itself is focused
       * (its own handler covers Up/Down/Home/End/PageUp/PageDown, not Left/Right).
       */
      if (
        (e.key === 'Enter' || e.key === ' ') &&
        el?.closest('button, a[href], summary, [role="radio"], [role="button"]')
      ) {
        return;
      }

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          step(e.shiftKey ? 5 : 1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          step(e.shiftKey ? -5 : -1);
          break;
        case 'm':
        case 'M':
          // Without this the same keystroke lands in the panel's autofocused
          // search box, so opening the map types "m" into it.
          e.preventDefault();
          setMapExpanded((v) => !v);
          break;
        case 'w':
        case 'W':
          e.preventDefault();
          if (scene?.status !== 'ready') break;
          if (scene.wideStatus === 'ready') setWidened((w) => !w);
          else {
            setWidened(true);
            void engine.widen(scene.key);
          }
          break;
        case 'Enter':
          e.preventDefault();
          // An errored scene is truthy, so gating on `!scene` alone made Enter
          // dead at exactly the moment a retry is wanted.
          if (!scene || scene.status === 'error') void pullLever();
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          togglePin();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleImmersive();
          break;
        case 'j':
        case 'J':
          e.preventDefault();
          setGalleryOpen((v) => !v);
          break;
        case ' ':
          // Blink comparator. Held, not toggled — a blink is a gesture.
          if (!comparing) break;
          e.preventDefault();
          if (!e.repeat) setPeeking(true);
          break;
        case 'Escape':
          // Lowest priority in the dismiss chain, after the map and the gate.
          // Immersive sits above the pin: when the controls are hidden, Escape
          // has to be able to bring them back before it does anything else.
          if (mapExpanded) setMapExpanded(false);
          else if (keyGateOpen) setKeyGateOpen(false);
          else if (immersive) toggleImmersive();
          else setPin(null);
          break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setPeeking(false);
    };
    // Releasing Space while the window is unfocused would never fire keyup and
    // would strand the peek on screen.
    const onBlur = () => setPeeking(false);

    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [step, engine, scene, togglePin, comparing, mapExpanded, keyGateOpen, pullLever, immersive, toggleImmersive, galleryOpen, filmWarnPending]);

  const saveKey = (value: string = keyDraft) => {
    const trimmed = value.trim();
    if (!trimmed && apiKey) {
      // "Done" with the field left blank means "keep the key I already have".
      setKeyGateOpen(false);
      return;
    }
    if (!trimmed) return;
    safeStorage.set(provider === 'venice' ? STORAGE_KEY_VENICE_API : STORAGE_KEY_API, trimmed);
    setApiKeys((current) => ({ ...current, [provider]: trimmed }));
    setKeyDraft('');
    setKeyGateOpen(false);
  };

  /** The scene the caption is describing: this station's, else the holdover. */
  const shownScene = scene?.status === 'ready' ? scene : displayed;
  const shownYear = shownScene?.year ?? year;
  const shownAccent = eraAccent(shownYear);

  /**
   * What the dial is aimed at that the picture is NOT — by axis, not by key.
   *
   * Comparing scene keys only tells you THAT they differ. The controls move on
   * three independent axes (when, where, and which look), so a notice that always
   * announces the year would read "dial set to 1900 AD" while the caption also
   * said 1900 AD — the one case where the user moved the map instead of the dial.
   */
  const aimedAt = useMemo(() => {
    if (!shownScene || shownScene.key === currentKey) return null;
    const parts: string[] = [];
    if (shownScene.year !== year) parts.push(formatYear(year));
    if (shownScene.location !== location) parts.push(location);
    if (shownScene.styleId !== styleKey) parts.push(findStyle(styleId).label.toLowerCase());
    if (findPhase(shownScene.phaseId).id !== phaseId) parts.push(findPhase(phaseId).label);
    return parts.length ? parts : null;
  }, [shownScene, currentKey, year, location, styleKey, styleId, phaseId]);

  /**
   * One station seating, as one event.
   *
   * Alternating data-seat="a"|"b" is what RESTARTS the animation: swapping
   * animation-name is the only way CSS can replay one without a remount, so the
   * shock costs no reflow and no JS animation anywhere. `solid` records whether
   * the station you landed on is one you already own, which lets the dial's
   * contact fire only then — so you learn the shape of your own archive by feel.
   */
  const [seat, setSeat] = useState({ n: 0, solid: false });
  const [seatIndex, setSeatIndex] = useState(index);
  // Also render-phase: the seat drives a CSS animation keyed on `n`, and firing
  // it one commit late meant the click landed after the needle had already
  // stopped. Initialised to the first index so arriving on a station does not
  // count as moving to it.
  if (index !== seatIndex) {
    setSeatIndex(index);
    setSeat((s) => ({ n: s.n + 1, solid: statusByYear.get(STATIONS[index]!) === 'ready' }));
  }

  const status = scene?.status;
  const failure = scene?.failure;

  /**
   * Nothing developed yet — so show the world instead of a blank gradient. The
   * map is only the home screen while there is no photograph; the instant one
   * lands, `displayed` fills and the frame takes the stage back. The app's
   * thesis, that the generated view is the entire screen, is unchanged; this
   * fills the hole where there is no view to give.
   */
  const homeMode = !displayed && !mapExpanded;
  const stageLabel =
    status === 'queued' ? 'queued'
    : status === 'restoring' ? 'from your archive'
    : status === 'directing' ? 'composing the scene'
    : status === 'rendering' ? 'developing the frame'
    : status === 'error' ? 'no image'
    : null;

  const prefetchCount = useMemo(
    () => scenes.filter((s) => s.status === 'directing' || s.status === 'rendering' || s.status === 'queued').length,
    [scenes],
  );

  // Read straight off the engine during render rather than memoised: the engine
  // emits after every persist and after hydration, and useSyncExternalStore
  // re-renders on emit, so these are always current without a second
  // subscription or a fake dependency on `scenes`.
  const storedCount = engine.storedFrameCount;
  const storedMb = (engine.storedBytes / (1024 * 1024)).toFixed(1);

  return (
    <div
      className={`portal${immersive ? ' portal--immersive' : ''}${homeMode ? ' portal--home' : ''}`}
      // undefined on mount, so nothing jolts on first paint.
      data-seat={seat.n ? (seat.n % 2 ? 'a' : 'b') : undefined}
      style={{ ['--accent' as string]: accent }}
    >
      <PortalView
        year={year}
        scene={scene}
        holdover={displayed}
        scrubbing={scrubbing}
        onFrameError={handleFrameError}
        jump={jump}
        videoUrl={scene?.videoStatus === 'ready' ? scene.videoUrl : undefined}
        wideUrls={widened && scene?.wideStatus === 'ready' ? scene.wideUrls : undefined}
        pinned={comparing ? pinnedScene : undefined}
        pinnedSideValue={activePin ? pinnedSide(activePin, index) : 'left'}
        pinnedAccent={pinnedYear !== undefined ? eraAccent(pinnedYear) : accent}
        pinnedLabel={pinnedYear !== undefined ? formatYear(pinnedYear) : ''}
        deltaLabel={
          pinnedYear !== undefined
            ? `${year - pinnedYear >= 0 ? '+' : '−'}${Math.abs(year - pinnedYear).toLocaleString()} yrs`
            : ''
        }
        seam={seam}
        onSeamChange={setSeam}
        peeking={peeking}
      />

      {/* ---- top bar ---- */}
      <header className="portal-top">
        <div className="brand">
          <span className="brand-mark" />
          <span className="brand-text">THE LOOKING GLASS</span>
        </div>

        <div className="top-right">
          <LookPicker
            presets={STYLE_PRESETS}
            styleId={styleId}
            onStyleChange={setStyleId}
            customStyle={customStyle}
            onCustomStyleChange={setCustomStyle}
            open={lookOpen}
            onOpenChange={setLookOpen}
          />
          {/* Home mode hides the map panel's own search field: the panel sits
              beneath .portal's era wash and veiling glare, where a dark field is
              simply not legible. Opening the real panel instead is one click,
              lands it above everything, and brings the globe toggle with it. */}
          {homeMode && (
            <button className="ghost-btn" onClick={() => setMapExpanded(true)}>
              search
            </button>
          )}
          <button className="ghost-btn" onClick={() => setGalleryOpen(true)}>
            journeys
          </button>
          <button
            className="ghost-btn ghost-btn--fullscreen"
            onClick={toggleImmersive}
            aria-pressed={immersive}
            aria-label={immersive ? 'Leave fullscreen view' : 'Fullscreen the view'}
            title={immersive ? 'Leave fullscreen (F)' : 'Fullscreen the view (F)'}
          >
            {/* An unlabelled 13px glyph was not discoverable — a first-time
                visitor had no way to know this was the way to fill the screen.
                It now carries a word as well as a mark, and takes the era
                accent so it reads as an invitation rather than as chrome. */}
            <span className="fs-glyph" aria-hidden="true">
              {immersive ? '⤡' : '⤢'}
            </span>
            <span className="fs-label">{immersive ? 'exit' : 'fullscreen'}</span>
          </button>
          <button className="ghost-btn" onClick={() => setKeyGateOpen(true)}>
            {apiKey ? 'settings' : 'set key'}
          </button>
        </div>
      </header>

      {/* ---- narrative + stage ---- */}
      <div className="portal-caption">
        {/* Describes the PICTURE, not the dial. While the dial is aimed somewhere
            we have not been yet, these keep naming the frame actually on screen —
            otherwise holding the last frame would turn the caption into a lie
            about it. `aimedAt` then names whichever axes the controls have moved
            away on — when, where, or which look. */}
        <div className="caption-head" style={{ ['--shown-accent' as string]: shownAccent }}>
          <span className="caption-place">{shownScene?.location ?? location}</span>
          <span className="caption-sep">·</span>
          <span className="caption-year">
            {formatYear(shownYear)}
          </span>
          <span className="caption-era">{getEraBand(shownYear).label}</span>
        </div>

        {shownScene?.narrative && <p className="caption-prose">{shownScene.narrative}</p>}

        {aimedAt && (
          <div className="caption-aim" style={{ ['--aim-accent' as string]: accent }} aria-live="polite">
            <span className="aim-arrow" aria-hidden="true">
              ⟶
            </span>
            aimed at{' '}
            <strong>{aimedAt.join(' · ')}</strong>
            <span className="aim-hint">pull the lever to travel</span>
          </div>
        )}

        {pinNotice && (
          <div className="caption-stage" aria-live="polite">
            <span className="stage-pip" style={{ color: accent }} />
            {pinNotice}
          </div>
        )}

        {stageLabel && (
          <div
            className={`caption-stage${status === 'error' ? ' caption-stage--error' : ''}`}
            // Scene resolution is entirely async, so without a live region a
            // screen reader never learns the frame arrived or failed.
            aria-live="polite"
          >
            <span className="stage-pip" style={{ color: accent }} />
            {stageLabel}
            {status === 'error' && !failure && scene?.error && (
              <span className="stage-detail">{scene.error}</span>
            )}
          </div>
        )}

        {/* A failure is the one moment the app owes the user a full sentence and
            a button. The strip above is a status line — fine for "developing the
            frame", useless for "your key has no credit on it", which needs to
            say whose problem it is, whether pulling again could ever work, and
            where to go. Rendered from the classified kind, so the advice cannot
            drift from the cause. */}
        {status === 'error' && failure && (
          <div className="fault" role="alert">
            <div className="fault-title">{failure.title}</div>
            <div className="fault-detail">{failure.detail}</div>
            <div className="fault-actions">
              {failure.action?.openSettings && (
                <button className="ghost-btn" onClick={() => setKeyGateOpen(true)}>
                  {failure.action.label}
                </button>
              )}
              {failure.action?.href && (
                <a className="ghost-btn" href={failure.action.href} target="_blank" rel="noreferrer">
                  {failure.action.label}
                </a>
              )}
              {/* Offered only when retrying is genuinely plausible. A retry
                  button on a 402 is a button that spends nothing and fixes
                  nothing, and it teaches people to mash it. */}
              {failure.retry && (
                <button
                  className="solid-btn"
                  onClick={() =>
                    engine.retry({ year, coordinates, location, styleId: styleKey, phaseId })
                  }
                >
                  try again
                </button>
              )}
            </div>
          </div>
        )}

        {/* A degraded frame is still a frame, so it gets a quiet note rather than
            the error treatment — but it does not get to pass as a good one. */}
        {scene?.degraded && status === 'ready' && (
          <div className="caption-stage caption-stage--degraded" aria-live="polite">
            <span className="stage-pip" style={{ color: '#e0b24a' }} />
            {scene.degraded}
          </div>
        )}

        {status === 'error' && !failure && (
          <button
            className="caption-cta"
            onClick={() => engine.retry({ year, coordinates, location, styleId: styleKey, phaseId })}
          >
            try this year again ↻
          </button>
        )}

        {!apiKey && (
          <button className="caption-cta" onClick={() => setKeyGateOpen(true)}>
            connect an AI provider to open the portal →
          </button>
        )}

        {scene?.status === 'ready' && (
          <button
            className="caption-cta"
            onClick={() => {
              // Once the peripherals exist, widening is a free toggle — they are
              // already paid for, so re-collapsing must not re-generate them.
              if (scene.wideStatus === 'ready') setWidened((w) => !w);
              else {
                setWidened(true);
                void engine.widen(scene.key);
              }
            }}
            disabled={scene.wideStatus === 'loading'}
          >
            {scene.wideStatus === 'loading'
              ? 'widening…'
              : scene.wideStatus === 'error'
                ? 'widening failed — try again (W)'
                : scene.wideStatus === 'ready'
                  ? widened
                    ? 'narrow the view (W)'
                    : 'widen the view (W)'
                  : 'widen the view (W)'}
          </button>
        )}

        {scene?.status === 'ready' && (
          <FilmControl
            scene={scene}
            seconds={filmSeconds}
            onSecondsChange={setFilmSeconds}
            onRender={requestFilm}
            lengths={FILM_LENGTHS}
          />
        )}

        {scene?.videoStatus === 'ready' && scene.videoContinuous === false && (
          <div className="caption-stage caption-stage--degraded" aria-live="polite">
            <span className="stage-pip" style={{ color: '#e0b24a' }} />
            the still was refused as a source frame — this clip is a fresh take
          </div>
        )}

        {scene?.videoStatus === 'error' && scene.videoError && (
          <div className="caption-stage caption-stage--degraded" aria-live="polite">
            <span className="stage-pip" style={{ color: '#e0b24a' }} />
            <span className="stage-detail">{scene.videoError}</span>
          </div>
        )}

        {scene?.wideStatus === 'error' && scene.wideError && (
          <div className="caption-stage caption-stage--degraded" aria-live="polite">
            <span className="stage-pip" style={{ color: '#e0b24a' }} />
            <span className="stage-detail">{scene.wideError}</span>
          </div>
        )}
      </div>

      {/* The peripheral frames used to render here as two 168px thumbnails pinned
          to the top-right — where they collided with the sound toggle at the same
          coordinates and sat underneath the Look menu when it opened. They are now
          drawn as a full panorama inside PortalView, which is what "widen the
          view" actually promises. */}

      {/* ---- controls ---- */}
      <div className="portal-bottom">
        <PlaceDial
          coordinates={coordinates}
          location={location}
          onPick={pickPlace}
          expanded={mapExpanded || homeMode}
          onExpandedChange={setMapExpanded}
          home={homeMode}
          accent={accent}
        />
        <SunDial phaseId={phaseId} onChange={setPhaseId} accent={accent} />
        <TimeDial
          index={index}
          exactYear={exactYear}
          onIndexChange={setIndex}
          statusByYear={statusByYear}
          onScrubbingChange={setScrubbing}
          onYearEntry={(y) => {
            // Index for the ribbon's position and the neighbour lookups; the
            // exact year for everything that matters. setExactYear runs second
            // because setIndex clears it.
            setIndex(nearestStationIndex(y));
            setExactYear(STATIONS.includes(y) ? null : y);
          }}
          seat={seat}
          pinIndex={activePin ? activePin.index : null}
          pinAccent={pinnedYear !== undefined ? eraAccent(pinnedYear) : accent}
        />
        <TimeLever
          armed={(!scene || scene.status === 'error') && !scrubbing && !placeCoversLever}
          blockedReason={placeCoversLever ? 'Close the place panel to reach the lever' : undefined}
          retry={scene?.status === 'error'}
          busy={Boolean(scene) && scene?.status !== 'ready' && scene?.status !== 'error'}
          onPull={pullLever}
          accent={accent}
          label={formatYear(year)}
        />

        <div className="portal-hints">
          <span><kbd>↵</kbd> jump</span>
          <span><kbd>←</kbd><kbd>→</kbd> step</span>
          <span><kbd>M</kbd> place</span>
          <span><kbd>W</kbd> widen</span>
          <span><kbd>F</kbd> full</span>
          <span><kbd>J</kbd> journeys</span>
          <span>
            <kbd>P</kbd> {activePin ? 'unpin' : 'hold'}
            {comparing && <> · <kbd>SPC</kbd> peek</>}
          </span>
          {prefetchCount > 0 && <span className="hint-busy">{prefetchCount} in flight</span>}
          {/* What you own. Frames cost money and now survive reload, so the count
              is real standing state rather than a debug readout. */}
          {storedCount > 0 && (
            <span className="hint-archive" title={`${storedMb} MB kept in this browser`}>
              {storedCount} kept
            </span>
          )}
        </div>
      </div>

      {/* The one control that survives immersive mode. Rendered outside the
          chrome it is escaping from, because a button hidden by the state it
          exits is a trap — and the keyboard hint next to it teaches the shortcut
          that makes it unnecessary. */}
      {immersive && (
        <button className="immersive-exit" onClick={toggleImmersive}>
          <kbd>F</kbd> leave fullscreen
        </button>
      )}

      {galleryOpen && (
        <JourneyGallery
          onClose={() => setGalleryOpen(false)}
          onPick={takeJourney}
          currentYear={year}
          currentLocation={location}
        />
      )}

      {/* ---- key gate ---- */}
      {filmWarnPending && (
        <FilmWarning
          seconds={filmSeconds}
          onConfirm={confirmFilm}
          onCancel={() => setFilmWarnPending(false)}
        />
      )}

      {keyGateOpen && (
        <Settings
          provider={provider}
          onProviderChange={(next) => {
            setKeyDraft('');
            changeProvider(next);
          }}
          draft={keyDraft}
          onDraftChange={setKeyDraft}
          onSaveKey={saveKey}
          onDismiss={() => setKeyGateOpen(false)}
          hasKey={Boolean(apiKey)}
          savedKey={apiKey}
          models={models}
          onModelsChange={changeModels}
          customStyle={customStyle}
          onCustomStyleChange={setCustomStyle}
          template={template}
          onTemplateChange={setTemplate}
          prefetchEnabled={prefetchEnabled}
          onPrefetchChange={setPrefetchEnabled}
        />
      )}
    </div>
  );
}
