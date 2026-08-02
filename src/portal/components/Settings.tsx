/**
 * Settings — the key, the custom style, and the image meta-prompt.
 *
 * This began as a key dialog. It grew because the meta-prompt is the
 * highest-leverage text in the app — it decides what every frame looks like —
 * and it had been buried in a string join where only the author could reach it.
 * Exposing it costs one collapsible section and hands the user the actual dial
 * that matters.
 *
 * It is a real modal: aria-modal, a labelled title, a Tab focus trap, and focus
 * restored to wherever it came from. Before that, a keyboard user could tab out
 * of it and retune time behind it — which also spent money, since the global
 * arrow handler stayed live.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_IMAGE_TEMPLATE,
  PROMPT_PLACEHOLDERS,
  validateTemplate,
} from '../../lib/promptTemplate';
import type { KeyStatus, ModelSelection } from '../../lib/openrouter';
import {
  PROVIDERS,
  keyUrlFor,
  providerLabel,
  stillModelsFor,
  verifyProviderKey,
  videoModelsFor,
} from '../../lib/provider';
import type { ProviderId } from '../../lib/provider';
import { explainFailure } from '../../lib/failure';
import type { Failure } from '../../lib/failure';

interface Props {
  provider: ProviderId;
  onProviderChange: (provider: ProviderId) => void;
  onSaveKey: (key: string) => void;
  onDismiss: () => void;
  draft: string;
  onDraftChange: (value: string) => void;
  hasKey: boolean;
  /** The key already in effect, so 'test this key' can test IT. */
  savedKey: string;
  customStyle: string;
  onCustomStyleChange: (value: string) => void;
  template: string;
  onTemplateChange: (value: string) => void;
  prefetchEnabled: boolean;
  onPrefetchChange: (value: boolean) => void;
  models: ModelSelection;
  onModelsChange: (models: ModelSelection) => void;
}

/**
 * A radio row of models. Rendered as buttons rather than a <select> because the
 * blurb is the whole point — "which of these is fastest" is the actual question
 * a user has, and a dropdown hides the answer behind a click.
 */
function ModelChoice({
  title,
  hint,
  options,
  value,
  onChange,
}: {
  title: string;
  hint: string;
  options: { id: string; label: string; blurb: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="model-choice">
      <div className="field-label">
        {title}
        <span className="field-hint">{hint}</span>
      </div>
      <div className="model-grid" role="radiogroup" aria-label={title}>
        {options.map((o) => {
          const on = o.id === value;
          return (
            <button
              key={o.id}
              role="radio"
              aria-checked={on}
              // Only the selected option is a tab stop; arrows move within the
              // group. That is what a radiogroup is, and it keeps five models
              // from costing five tabs each to walk past.
              tabIndex={on ? 0 : -1}
              className={`model-opt${on ? ' model-opt--on' : ''}`}
              onClick={() => onChange(o.id)}
              onKeyDown={(e) => {
                const d =
                  e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
                  : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1
                  : 0;
                if (!d) return;
                e.preventDefault();
                const i = options.findIndex((x) => x.id === value);
                const next = options[(i + d + options.length) % options.length]!;
                onChange(next.id);
                const group = e.currentTarget.parentElement;
                (group?.children[options.indexOf(next)] as HTMLElement | undefined)?.focus();
              }}
            >
              <span className="model-name">{o.label}</span>
              <span className="model-blurb">{o.blurb}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Settings({
  provider,
  onProviderChange,
  onSaveKey,
  onDismiss,
  draft,
  onDraftChange,
  hasKey,
  savedKey,
  customStyle,
  onCustomStyleChange,
  template,
  onTemplateChange,
  prefetchEnabled,
  onPrefetchChange,
  models,
  onModelsChange,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [checking, setChecking] = useState(false);
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [keyFailure, setKeyFailure] = useState<Failure | null>(null);

  const templateError = validateTemplate(template);

  /**
   * Check the key against the active provider's free account endpoint.
   * Without this the first thing a wrong key does is waste a place, a year, a
   * lever pull and a minute of tunnel before admitting it was never going to
   * work — and a key that is merely EMPTY looked identical to one that was
   * wrong. This distinguishes them, in advance, for free.
   */
  const check = useCallback(async (candidate: string) => {
    const key = candidate.trim();
    if (!key) return;
    setChecking(true);
    setKeyStatus(null);
    setKeyFailure(null);
    try {
      setKeyStatus(await verifyProviderKey(provider, key));
    } catch (err) {
      setKeyFailure(explainFailure(err, provider));
    } finally {
      setChecking(false);
    }
  }, [provider]);

  /** Shape check, instant and offline — the commonest paste error of all. */
  const shapeWarning =
    provider === 'openrouter' && draft.trim() && !draft.trim().startsWith('sk-or-')
      ? draft.trim().startsWith('sk-')
        ? 'That looks like an OpenAI key. OpenRouter keys begin with sk-or-.'
        : 'OpenRouter keys begin with sk-or-. Check you copied the whole thing.'
      : null;

  const stillModels = stillModelsFor(provider);
  const videoModels = videoModelsFor(provider);

  useEffect(() => {
    setKeyStatus(null);
    setKeyFailure(null);
  }, [provider]);

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null;
    // preventScroll, because the browser's "scroll the focused element into
    // view" ran against a body that had not finished laying out — and parked
    // the panel mid-scroll, clipping the key field under the title and pushing
    // the sentence explaining what a key is for off the top. On a first visit
    // that is the entire first impression.
    inputRef.current?.focus({ preventScroll: true });
    const restore = returnTo.current;
    return () => {
      // Restoring to a node that has since been unmounted would silently drop
      // focus to <body>, which is the bug this is here to prevent.
      if (restore && document.contains(restore)) restore.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const card = cardRef.current;
      if (!card) return;
      const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !card.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return (
    <div
      className="gate"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gate-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className={`gate-card${showPrompt ? ' gate-card--wide' : ''}`} ref={cardRef}>
        <h2 id="gate-title">{hasKey ? 'Settings' : 'Open the portal'}</h2>

        {/* Scrolls on its own so the action row below stays reachable. With the
            meta-prompt editor open this content is taller than most laptops, and
            previously "done" simply fell off the bottom of the screen. */}
        <div className="gate-body">
        <ModelChoice
          title="Provider"
          hint="where generation runs"
          options={PROVIDERS}
          value={provider}
          onChange={(id) => onProviderChange(id as ProviderId)}
        />

        <p>
          The portal generates every frame through {providerLabel(provider)}. Your key is
          stored in this browser&apos;s <code>localStorage</code> and is sent only to that
          provider.
        </p>

        <label className="field-label" htmlFor="set-key">
          {providerLabel(provider)} API key
        </label>
        <input
          id="set-key"
          ref={inputRef}
          type="password"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSaveKey(draft);
          }}
          placeholder={hasKey ? '•••••••• (saved) — type to replace' : provider === 'openrouter' ? 'sk-or-…' : 'VENICE_INFERENCE_KEY...'}
        />

        <div className="key-check">
          {/* Tests whatever key is actually in effect: the pasted draft if there
              is one, otherwise the saved key. Testing only the draft meant the
              button was dead for the single most useful case — "it stopped
              working, is my key still good?" — where there is nothing typed. */}
          <button
            className="ghost-btn"
            onClick={() => void check(draft.trim() || savedKey)}
            disabled={checking || (!draft.trim() && !savedKey)}
          >
            {checking ? 'checking…' : 'test this key'}
          </button>
          {shapeWarning && !keyStatus && !keyFailure && (
            <span className="key-verdict key-verdict--warn">{shapeWarning}</span>
          )}
          {keyStatus && (
            <span className="key-verdict key-verdict--ok">
              Key works
              {keyStatus.canConsume === false ? ' — no usable balance'
              : keyStatus.remaining !== undefined ?
                ` — ${keyStatus.currency === 'DIEM' ? '' : '$'}${keyStatus.remaining.toFixed(2)}${keyStatus.currency === 'DIEM' ? ' DIEM' : ''} left${keyStatus.resets ? ` this ${keyStatus.resets.replace(/ly$/, '')}` : ''}`
              : keyStatus.freeTier ? ' — free tier, tight rate limits'
              : ' — no spending cap set'}
            </span>
          )}
          {keyFailure && (
            <span className="key-verdict key-verdict--bad">
              {keyFailure.title}{' '}
              {keyFailure.action?.href && (
                <a href={keyFailure.action.href} target="_blank" rel="noreferrer">
                  {keyFailure.action.label}
                </a>
              )}
            </span>
          )}
        </div>

        <ModelChoice
          title="Stills"
          hint="what draws every frame"
          options={stillModels}
          value={models.wideField}
          onChange={(id) => onModelsChange({ ...models, wideField: id })}
        />

        <ModelChoice
          title="Film"
          hint="what animates a frame, with sound"
          /* Five is the right number to choose between; showing all eight turns
             a decision into a list. But a key saved before this picker existed
             can hold any of the eight, and slicing blindly would render a
             radiogroup with NOTHING selected and no way to see what is in use —
             so the current selection is always one of the options. */
          options={
            videoModels.slice(0, 5).some((m) => m.id === models.cinematic) ?
              videoModels.slice(0, 5)
            : [...videoModels.slice(0, 5), ...videoModels.filter((m) => m.id === models.cinematic)]
          }
          value={models.cinematic}
          onChange={(id) => {
            const option = videoModels.find((model) => model.id === id);
            onModelsChange({
              ...models,
              cinematic: id,
              cinematicText: option?.textModelId ?? id,
              animate: id,
            });
          }}
        />

        <label className="field-label" htmlFor="set-custom">
          Custom style
          <span className="field-hint">used by the CUSTOM chip</span>
        </label>
        <input
          id="set-custom"
          type="text"
          value={customStyle}
          onChange={(e) => onCustomStyleChange(e.target.value)}
          placeholder="e.g. shot on expired Polaroid, heavy light leaks"
        />

        {/* Off by default and stated in money, not in jargon. Anything that can
            spend on the user's behalf has to say so where they can see it. */}
        <label className="toggle">
          <input
            type="checkbox"
            checked={prefetchEnabled}
            onChange={(e) => onPrefetchChange(e.target.checked)}
          />
          <span className="toggle-body">
            <span className="toggle-title">Generate the next station ahead of me</span>
            <span className="toggle-hint">
              Makes arrow-stepping instant. Costs two extra frames every time you land — on
              your key. Off by default.
            </span>
          </span>
        </label>

        <button
          className="disclosure"
          onClick={() => setShowPrompt((v) => !v)}
          aria-expanded={showPrompt}
        >
          {/* The caret is its own element and rotates, rather than swapping ▸/▾
              as text: a glyph swap inside the label is what made this row wrap
              mid-phrase and orphan "looks" onto a second line. */}
          <span className="disclosure-caret" aria-hidden="true">
            ▸
          </span>
          <span className="disclosure-title">Image meta-prompt</span>
          <span className="disclosure-hint">decides how every frame looks</span>
          <span className="disclosure-state">{showPrompt ? 'hide' : 'edit'}</span>
        </button>

        {showPrompt && (
          <div className="prompt-editor">
            <p className="prompt-note">
              Written as prose on purpose: FLUX.2 and Nano Banana both read sentences, not
              tag lists, weight what comes first, and ignore negatives — so describe what
              you want present rather than what you want gone.
            </p>
            <textarea
              value={template}
              onChange={(e) => onTemplateChange(e.target.value)}
              spellCheck={false}
              rows={16}
              aria-label="Image meta-prompt template"
            />
            {templateError && <div className="prompt-error">{templateError}</div>}
            <details className="prompt-tokens">
              <summary>placeholders</summary>
              <dl>
                {PROMPT_PLACEHOLDERS.map((p) => (
                  <div key={p.key}>
                    <dt>
                      <code>{`{${p.key}}`}</code>
                    </dt>
                    <dd>{p.blurb}</dd>
                  </div>
                ))}
              </dl>
            </details>
            <div className="prompt-actions">
              <span className="prompt-status">
                {template === DEFAULT_IMAGE_TEMPLATE ? 'using the default' : 'edited'}
              </span>
              <button
                className="ghost-btn"
                onClick={() => onTemplateChange(DEFAULT_IMAGE_TEMPLATE)}
                disabled={template === DEFAULT_IMAGE_TEMPLATE}
              >
                reset to default
              </button>
            </div>
          </div>
        )}

        </div>

        <div className="gate-actions">
          <a href={keyUrlFor(provider)} target="_blank" rel="noreferrer">
            get a key ↗
          </a>
          <div>
            <button className="ghost-btn" onClick={onDismiss}>
              {hasKey ? 'close' : 'later'}
            </button>
            <button
              className="solid-btn"
              onClick={() => onSaveKey(draft)}
              disabled={!draft.trim() && !hasKey}
            >
              {hasKey ? 'done' : 'open'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
