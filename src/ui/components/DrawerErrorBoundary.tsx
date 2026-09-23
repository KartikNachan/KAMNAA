import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches React render errors in any drawer panel so a crash
 * never leaves the user staring at a blank white screen.
 */
export class DrawerErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error(`[KAMNAA] Drawer crash (${this.props.label ?? "unknown"}):`, error, info);
  }

  override render() {
    const { error } = this.state;
    if (error) {
      return (
        this.props.fallback ?? (
          <div className="p-4 space-y-3 font-mono-press">
            <div className="hallmark-card border-2 border-[var(--accent-primary)] p-3 bg-[var(--surface)]">
              <p className="text-[11px] font-bold text-[var(--accent-primary)] uppercase tracking-wider">
                Panel Error
              </p>
              <p className="text-[10px] text-[var(--text-secondary)] mt-1 break-all">
                {error.message}
              </p>
            </div>
            <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
              This panel crashed. Try reloading the extension: go to{" "}
              <span className="font-bold text-[var(--text-primary)]">
                chrome://extensions
              </span>{" "}
              and click the reload icon next to KAMNAA.
            </p>
            <button
              onClick={() => this.setState({ error: null })}
              className="hallmark-button text-[10px] px-3 py-1.5 uppercase font-bold w-full"
            >
              Dismiss & Retry
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
