import type { AgentTask, AgentStatus } from "../../types";

interface AgentStatusPanelProps {
  task: AgentTask | null;
}

const STATUS_CONFIG: Record<
  AgentStatus,
  { icon: string; color: string; bgColor: string; label: string }
> = {
  idle: { icon: "💤", color: "text-[var(--text-secondary)]", bgColor: "bg-[var(--surface)]", label: "Idle" },
  analyzing: { icon: "👁️", color: "text-[var(--accent-primary)]", bgColor: "bg-[var(--surface)]", label: "Analyzing Page" },
  planning: { icon: "🧠", color: "text-purple-400", bgColor: "bg-[var(--surface)]", label: "Planning Actions" },
  executing: { icon: "⚡", color: "text-[var(--accent-primary)]", bgColor: "bg-[var(--surface)]", label: "Executing" },
  verifying: { icon: "✅", color: "text-[var(--success)]", bgColor: "bg-[var(--surface)]", label: "Verifying" },
  recovering: { icon: "🔄", color: "text-[var(--accent-primary)]", bgColor: "bg-[var(--surface)]", label: "Recovering" },
  completed: { icon: "🎉", color: "text-[var(--success)]", bgColor: "bg-[var(--surface)]", label: "Completed" },
  partial: { icon: "⚠️", color: "text-[var(--accent-primary)]", bgColor: "bg-[var(--surface)]", label: "Partially Completed" },
  failed: { icon: "❌", color: "text-[var(--error)]", bgColor: "bg-[var(--surface)]", label: "Failed" },
  paused: { icon: "⏸️", color: "text-[var(--accent-primary)]", bgColor: "bg-[var(--surface)]", label: "Paused" },
  waiting_for_user: { icon: "🙋", color: "text-[var(--accent-soft)]", bgColor: "bg-[var(--surface)]", label: "Waiting for Input" },
};

export function AgentStatusPanel({ task }: AgentStatusPanelProps) {
  if (!task) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <div className="text-4xl mb-3">🐾</div>
        <p className="text-xs text-[var(--text-secondary)]">
          No active task. Start one from the Task tab.
        </p>
      </div>
    );
  }

  const config = STATUS_CONFIG[task.status];
  const progress = task.totalSteps > 0
    ? Math.round((task.currentStep / task.totalSteps) * 100)
    : 0;

  return (
    <div className="p-4 space-y-4">
      {/* Status Header */}
      <div className={`${config.bgColor} rounded-lg p-4 border border-[var(--border)]`}>
        <div className="flex items-center gap-3 mb-3">
          <span className="text-2xl">{config.icon}</span>
          <div>
            <h3 className={`text-sm font-semibold ${config.color}`}>
              {config.label}
            </h3>
            <p className="text-[11px] text-[var(--text-secondary)]">
              {task.description}
            </p>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-[var(--surface)] rounded-full h-2 mb-2">
          <div
            className="bg-[var(--accent-primary)] h-2 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-[var(--text-secondary)]">
          <span>Step {task.currentStep} / {task.totalSteps}</span>
          <span>{progress}%</span>
        </div>
      </div>

      {/* Step Details */}
      {task.status === "executing" && task.plan.steps.length > 0 && (
        <div className="bg-[var(--surface)] rounded-lg p-3 border border-[var(--border)]">
          <h4 className="text-[10px] text-[var(--text-secondary)] uppercase tracking-wider mb-2">
            Current Step
          </h4>
          {task.plan.steps[task.currentStep] && (
            <div className="space-y-1">
              <p className="text-[11px] text-[var(--text-secondary)]">
                {task.plan.steps[task.currentStep].reasoning}
              </p>
              <div className="flex items-center gap-3 text-[10px] text-[var(--text-secondary)]">
                <span>
                  Action: {task.plan.steps[task.currentStep].action.type}
                </span>
                <span>
                  Confidence: {Math.round(task.plan.steps[task.currentStep].confidence * 100)}%
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error Details */}
      {task.status === "failed" && task.error && (
        <div className="bg-[var(--surface)] rounded-lg p-3 border border-[var(--error)]">
          <h4 className="text-[10px] text-[var(--error)] uppercase tracking-wider mb-1">
            Error
          </h4>
          <p className="text-[11px] text-[var(--text-secondary)] font-mono">{task.error}</p>
        </div>
      )}

      {/* Result */}
      {task.status === "completed" && task.result && (
        <div className="bg-[var(--surface)] rounded-lg p-3 border border-[var(--success)]">
          <h4 className="text-[10px] text-[var(--success)] uppercase tracking-wider mb-1">
            Result
          </h4>
          <p className="text-[11px] text-[var(--text-secondary)]">{task.result}</p>
        </div>
      )}

      {/* Timing */}
      <div className="text-center text-[10px] text-[var(--text-secondary)]">
        {task.startTime && (
          <span>
            Started {new Date(task.startTime).toLocaleTimeString()}
            {task.endTime && (
              <> • Duration {((task.endTime - task.startTime) / 1000).toFixed(1)}s</>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
