import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  title: string;
  hint: string;
  retryLabel: string;
}

interface State {
  error: Error | null;
}

// Contains a rendering error to the current view instead of blanking the whole
// app. Keyed by the active tab in App, so switching tabs also resets it.
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('View crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="bg-white border border-rose-200 rounded-xl shadow-sm p-8 text-center max-w-xl mx-auto">
        <AlertTriangle size={36} className="text-rose-500 mx-auto mb-3" />
        <h4 className="font-display font-bold text-slate-800 text-sm">{this.props.title}</h4>
        <p className="text-xs text-slate-500 mt-1">{this.props.hint}</p>
        <pre className="text-[10px] text-rose-700 bg-rose-50 border border-rose-100 rounded-lg p-2 mt-3 whitespace-pre-wrap text-left">
          {this.state.error.message}
        </pre>
        <button
          onClick={() => this.setState({ error: null })}
          className="mt-4 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg inline-flex items-center gap-1.5"
        >
          <RefreshCw size={13} /> {this.props.retryLabel}
        </button>
      </div>
    );
  }
}
