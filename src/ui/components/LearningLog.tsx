import { useState, useEffect, useRef } from "react";
import { getEntries, onLogEntry, clearEntries, type LogEntry } from "../../core/agent/learning-log";

const PHASE_COLORS: Record<LogEntry["phase"], string> = {
  discovery: "text-[var(--accent-primary)]",
  analysis: "text-[var(--text-primary)]",
  action: "text-[var(--text-secondary)]",
  success: "text-[var(--accent-primary)]",
  warning: "text-[var(--accent-primary)]",
  error: "text-[var(--accent-primary)]",
  learning: "text-[var(--accent-primary)]",
};

export function LearningLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEntries(getEntries());
    const unsub = onLogEntry((newEntries) => {
      setEntries([...newEntries]);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6 space-y-3 font-sans text-[var(--text-primary)]">
        <div className="w-10 h-10 hallmark-card flex items-center justify-center text-[var(--text-primary)] mb-1 border-2 border-[var(--border)] bg-[var(--surface)]">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <h3 className="text-xs font-mono-press font-bold uppercase tracking-wider text-[var(--text-primary)]">
          Agent Learning Log
        </h3>
        <p className="text-xs font-body-editorial text-[var(--text-secondary)] leading-relaxed max-w-xs font-medium">
          Real-time trace of on-device DOM perception, ViT visual grounding, and PII checksum audits.
        </p>
      </div>
    );
  }

  const recentEntries = entries.slice(-100);

  return (
    <div className="flex flex-col h-full font-sans text-[var(--text-primary)]">
      {/* Header Bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b-2 border-[var(--border)] hallmark-card bg-[var(--surface)]">
        <span className="text-[10px] uppercase font-mono-press font-bold tracking-wider text-[var(--text-secondary)]">
          {entries.length} Execution Traces
        </span>
        <button
          onClick={() => { clearEntries(); setEntries([]); }}
          className="text-[10px] uppercase font-mono-press font-bold tracking-wider text-[var(--accent-primary)] hover:text-[var(--text-primary)] transition-colors"
        >
          Clear Log
        </button>
      </div>

      {/* Log Stream */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2.5 space-y-2 custom-scrollbar font-mono-press text-xs">
        {recentEntries.map((entry) => (
          <div
            key={entry.id}
            className="hallmark-card p-2.5 border-2 border-[var(--border)] bg-[var(--surface)] space-y-1"
          >
            <div className="flex items-center justify-between text-[9px] uppercase tracking-wider font-mono-press">
              <span className={`font-bold ${PHASE_COLORS[entry.phase]}`}>
                • {entry.phase}
              </span>
              <span className="text-[var(--text-secondary)] font-semibold">
                {new Date(entry.timestamp).toLocaleTimeString([], { hour12: false, minute: "2-digit", second: "2-digit" })}
              </span>
            </div>
            <p className="text-[var(--text-primary)] font-body-editorial font-medium text-xs leading-snug break-words">
              {entry.message}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
