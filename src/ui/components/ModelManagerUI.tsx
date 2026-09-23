// ============================================================
// KAMNAA — Model Manager UI
// Shows on-device ML model status, download progress, and backend info.
// Uses the offscreen RPC bus for model operations.
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { callOffscreen, onModelProgress } from "../../core/runtime/messaging";
import type {
  ModelStatus,
  ModelProgress,
  BackendProfile,
  ModelId,
} from "../../types/runtime";

export function ModelManagerUI() {
  const [statuses, setStatuses] = useState<ModelStatus[]>([]);
  const [progress, setProgress] = useState<Record<string, ModelProgress>>({});
  const [backend, setBackend] = useState<string>("detecting...");
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    loadStatus();
    const unsub = onModelProgress((p: ModelProgress) => {
      setProgress((prev) => ({ ...prev, [p.id]: p }));
    });
    return unsub;
  }, []);

  async function loadStatus() {
    try {
      const be: BackendProfile = await callOffscreen("detectBackend", undefined);
      setBackend(be.summary);
      const s: ModelStatus[] = await callOffscreen("getModelStatuses", undefined);
      setStatuses(s);
    } catch (err) {
      setBackend("offline");
      console.warn("[KAMNAA] Failed to load model statuses:", err);
    }
  }

  const warmModel = useCallback(async (id: ModelId) => {
    setLoading((prev) => ({ ...prev, [id]: true }));
    try {
      await callOffscreen("warmModels", { ids: [id] });
      await loadStatus();
    } catch (err) {
      console.warn(`[KAMNAA] Failed to warm ${id}:`, err);
    } finally {
      setLoading((prev) => ({ ...prev, [id]: false }));
    }
  }, []);

  const warmAll = useCallback(async () => {
    const allIds = statuses.map((s) => s.id);
    setLoading((prev) => {
      const next = { ...prev };
      for (const id of allIds) next[id] = true;
      return next;
    });
    try {
      await callOffscreen("warmModels", { ids: allIds });
      await loadStatus();
    } catch (err) {
      console.warn("[KAMNAA] Failed to warm all models:", err);
    } finally {
      setLoading({});
    }
  }, [statuses]);

  const allRequiredReady = statuses
    .filter((s) => s.required)
    .every((s) => s.state === "ready" || s.state === "cached");
  const totalSize = statuses.reduce((sum, s) => sum + s.sizeBytes, 0);
  const loadedSize = statuses
    .filter((s) => s.state === "ready" || s.state === "cached")
    .reduce((sum, s) => sum + s.sizeBytes, 0);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--text-secondary)]">🧠 Vision Models</h2>
        <span className="text-[10px] px-2 py-0.5 rounded bg-[var(--surface)] text-[var(--text-secondary)] font-mono">
          {backend}
        </span>
      </div>

      {/* Overall Status */}
      <div
        className={`rounded-lg p-3 border ${
          allRequiredReady
            ? "bg-[var(--surface)] border-[var(--success)]"
            : "bg-[var(--surface)] border-[var(--border)]"
        }`}
      >
        <div className="flex items-center gap-2 mb-1">
          <span>{allRequiredReady ? "✅" : "⏳"}</span>
          <span
            className={`text-xs font-medium ${
              allRequiredReady ? "text-[var(--success)]" : "text-[var(--accent-primary)]"
            }`}
          >
            {allRequiredReady
              ? "All required models loaded"
              : "Models needed for visual perception"}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-2">
          <div className="flex-1 bg-[var(--surface)] rounded-full h-1.5">
            <div
              className="bg-[var(--accent-primary)] h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${totalSize > 0 ? (loadedSize / totalSize) * 100 : 0}%` }}
            />
          </div>
          <span className="text-[10px] text-[var(--text-secondary)]">
            {(loadedSize / 1024 / 1024).toFixed(1)}/{(totalSize / 1024 / 1024).toFixed(1)} MB
          </span>
        </div>
      </div>

      {/* Model List */}
      <div className="space-y-2">
        {statuses.map((status) => {
          const prog = progress[status.id];
          const isLoading = loading[status.id];

          return (
            <div key={status.id} className="bg-[var(--surface)] rounded-lg p-3 border border-[var(--border)]">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm">
                    {status.state === "ready"
                      ? "✅"
                      : status.state === "cached"
                        ? "📦"
                        : status.state === "downloading"
                          ? "⬇️"
                          : status.state === "loading"
                            ? "⚙️"
                            : status.state === "error"
                              ? "❌"
                              : "⬜"}
                  </span>
                  <span className="text-xs text-[var(--text-secondary)] font-medium">{status.name}</span>
                  {status.required && (
                    <span className="text-[9px] px-1 py-0.5 bg-[var(--surface)] text-[var(--accent-primary)] rounded">
                      required
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-[var(--text-secondary)]">
                  {(status.sizeBytes / 1024 / 1024).toFixed(1)}MB
                </span>
              </div>

              <p className="text-[10px] text-[var(--text-secondary)] mb-2">{status.kind}</p>

              {/* Progress Bar */}
              {prog && prog.state !== "ready" && prog.state !== "error" && (
                <div className="mb-2">
                  <div className="w-full bg-[var(--surface)] rounded-full h-1.5">
                    <div
                      className="bg-[var(--accent-primary)] h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${Math.round(prog.progress * 100)}%` }}
                    />
                  </div>
                  <p className="text-[9px] text-[var(--text-secondary)] mt-1">
                    {prog.state === "downloading"
                      ? `Downloading... ${Math.round(prog.progress * 100)}%`
                      : "Loading model..."}
                  </p>
                </div>
              )}

              {/* Error */}
              {prog?.state === "error" && (
                <p className="text-[10px] text-[var(--error)] mb-2">❌ {prog.error}</p>
              )}

              {/* Action Button */}
              {status.state !== "ready" && status.state !== "cached" && (
                <button
                  onClick={() => warmModel(status.id)}
                  disabled={isLoading}
                  className="text-[10px] px-3 py-1 bg-[var(--accent-primary)] hover:bg-[var(--accent-primary)] disabled:bg-[var(--surface)] text-[var(--surface)] rounded transition-colors"
                >
                  {isLoading ? "Loading..." : "Download"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={warmAll}
          className="flex-1 text-[11px] py-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-primary)] text-[var(--surface)] rounded-lg transition-colors"
        >
          Download All
        </button>
        <button
          onClick={loadStatus}
          className="text-[11px] px-3 py-2 bg-[var(--surface)] hover:bg-[var(--surface)] text-[var(--text-secondary)] rounded-lg transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Info */}
      <div className="bg-[var(--surface)] rounded-lg p-3 border border-[var(--border)]">
        <h4 className="text-[10px] text-[var(--text-secondary)] uppercase tracking-wider mb-2">How It Works</h4>
        <div className="space-y-1 text-[11px] text-[var(--text-secondary)]">
          <p>
            🔍 <strong>DOM path</strong> (default): Extracts page structure from HTML — fast (~10ms)
          </p>
          <p>
            👁️ <strong>Vision path</strong> (with models): Processes screenshots via ONNX —
            universal (~200ms)
          </p>
          <p>
            🔗 <strong>Hybrid path</strong>: DOM structure + vision text — most accurate
          </p>
        </div>
        <p className="text-[10px] text-[var(--text-secondary)] mt-2">
          Models run entirely in your browser via the offscreen ML host. Zero data leaves your
          device.
        </p>
      </div>
    </div>
  );
}
