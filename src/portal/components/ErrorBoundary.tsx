/**
 * Last line of defence for the portal.
 *
 * v1 had an error boundary; the portal shipped without one. That was survivable
 * while the portal lived at a second entry point, but index.html is now the site
 * any throw during mount served a blank dark page at the public URL with no
 * message — indistinguishable from a broken deploy, and impossible for a visitor
 * to report usefully. A boundary turns every such failure into something legible
 * with a way out.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[looking-glass] portal crashed', error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  private hardReset = (): void => {
    // The most likely unrecoverable state is corrupt persisted data, so offer a
    // reset that actually clears it rather than a reload that reproduces it.
    try {
      indexedDB.deleteDatabase('looking-glass-portal');
    } catch {
      /* nothing better to do */
    }
    try {
      localStorage.removeItem('looking-glass-model-selection');
      localStorage.removeItem('looking-glass-venice-model-selection');
      localStorage.removeItem('looking-glass-provider');
      localStorage.removeItem('looking-glass-style');
    } catch {
      /* storage may be blocked; that is survivable */
    }
    window.location.href = window.location.pathname;
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash" role="alert">
        <div className="crash-card">
          <h1>The portal did not open</h1>
          <p>
            Something failed while starting up. Your API key has not been touched and no
            generation was billed.
          </p>
          <pre>{error.message || String(error)}</pre>
          <div className="crash-actions">
            <button className="ghost-btn" onClick={this.reset}>
              try again
            </button>
            <button className="solid-btn" onClick={this.hardReset}>
              reset saved data
            </button>
          </div>
          <p className="crash-note">
            “Reset saved data” clears cached frames and display settings from this browser.
            It does not remove your API key.
          </p>
        </div>
      </div>
    );
  }
}
