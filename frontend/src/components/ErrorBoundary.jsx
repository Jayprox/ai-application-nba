import { Component } from 'react';

// Last line of defence: a render bug on one page shows a message instead of
// a blank screen, and the nav still works (Layout keys this by route).
export default class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[ui] render error', error, info?.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-[10px] border border-accent/40 bg-card p-6 text-[15px]">
        <strong>Something went wrong showing this page.</strong>
        <span className="text-muted">The rest of the app still works. Try reloading, or go back.</span>
        <div className="flex gap-3">
          <button type="button" onClick={() => window.location.reload()} className="h-10 cursor-pointer rounded-lg border border-field bg-card px-4 font-medium hover:border-muted">Reload</button>
          <button type="button" onClick={() => window.history.back()} className="h-10 cursor-pointer rounded-lg border border-field bg-card px-4 font-medium hover:border-muted">Go back</button>
        </div>
      </div>
    );
  }
}
