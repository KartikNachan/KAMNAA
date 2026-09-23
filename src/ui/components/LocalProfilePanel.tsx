import { useState, useEffect } from "react";
import { 
  loadProfile, 
  saveProfile, 
  clearProfile, 
  isFieldSensitive, 
  KamnaaProfile,
  createEmptyProfile
} from "../../core/profile/local-profile";

export function LocalProfilePanel() {
  const [profile, setProfile] = useState<KamnaaProfile>(createEmptyProfile());
  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());
  const [isEditing, setIsEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [newFieldMode, setNewFieldMode] = useState<keyof KamnaaProfile | null>(null);
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldValue, setNewFieldValue] = useState("");

  useEffect(() => {
    reloadProfile();
  }, []);

  const reloadProfile = async () => {
    const p = await loadProfile();
    setProfile(p);
  };

  const handleClear = async () => {
    if (confirm("Are you sure you want to clear your local profile? This cannot be undone.")) {
      await clearProfile();
      await reloadProfile();
      setRevealedFields(new Set());
    }
  };

  const toggleReveal = (field: string) => {
    setRevealedFields(prev => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  const handleSaveField = async (category: keyof KamnaaProfile, field: string, value: string) => {
    const updated = { ...profile };
    if (!updated[category]) (updated as any)[category] = {};
    (updated[category] as any)[field] = value;
    await saveProfile(updated);
    setProfile(updated);
    setIsEditing(null);
  };

  const handleDeleteField = async (category: keyof KamnaaProfile, field: string) => {
    const updated = { ...profile };
    if (updated[category]) {
      delete (updated[category] as any)[field];
      await saveProfile(updated);
      setProfile(updated);
    }
  };

  const renderFieldValue = (category: keyof KamnaaProfile, field: string, value: string) => {
    if (isEditing === field) {
      return (
        <div className="flex items-center gap-2 flex-1">
          <input
            type="text"
            className="flex-1 bg-[var(--surface)] text-[var(--text-primary)] border border-[var(--border)] px-2 py-1 text-xs"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSaveField(category, field, editValue);
              }
            }}
            autoFocus
          />
          <button 
            className="text-[var(--success)] text-xs font-bold"
            onClick={() => handleSaveField(category, field, editValue)}
          >
            SAVE
          </button>
          <button 
            className="text-[var(--text-secondary)] text-xs"
            onClick={() => setIsEditing(null)}
          >
            CANCEL
          </button>
        </div>
      );
    }

    const isSensitive = isFieldSensitive(field);
    const isRevealed = revealedFields.has(field);
    
    // Simple mask for sensitive fields
    let displayValue = value;
    if (isSensitive && !isRevealed) {
      if (value.length > 4) {
        displayValue = "•".repeat(value.length - 4) + value.slice(-4);
      } else {
        displayValue = "••••••••";
      }
    }

    return (
      <div className="flex items-center justify-between flex-1 group">
        <span className={`font-mono text-xs ${isSensitive && !isRevealed ? "text-[var(--text-secondary)] tracking-widest" : "text-[var(--text-primary)]"}`}>
          {displayValue}
        </span>
        <div className="hidden group-hover:flex items-center gap-2">
          {isSensitive && (
            <button 
              className="text-[var(--accent-primary)] text-[10px] uppercase font-bold"
              onClick={() => toggleReveal(field)}
              title={isRevealed ? "Hide" : "Reveal"}
            >
              {isRevealed ? "HIDE" : "REVEAL"}
            </button>
          )}
          <button 
            className="text-[var(--accent-primary)] text-[10px] uppercase font-bold"
            onClick={() => {
              setIsEditing(field);
              setEditValue(value);
            }}
          >
            EDIT
          </button>
          <button 
            className="text-[var(--error)] text-[10px] uppercase font-bold"
            onClick={() => handleDeleteField(category, field)}
          >
            DEL
          </button>
        </div>
      </div>
    );
  };

  const renderCategory = (title: string, category: keyof KamnaaProfile, schemaKeys?: string[]) => {
    const data = profile[category] as Record<string, string>;
    const keys = schemaKeys || Object.keys(data);
    
    // For schema-defined sections, show the key even if empty so the user can click "Add"
    const displayKeys = Array.from(new Set([...keys, ...Object.keys(data)]));

    if (displayKeys.length === 0 && category === "custom") return null;

    return (
      <div className="mb-6">
        <h3 className="text-xs font-bold text-[var(--text-secondary)] uppercase tracking-wider mb-2 border-b border-[var(--border)] pb-1">
          {title}
        </h3>
        <div className="space-y-2 mt-2">
          {displayKeys.map(k => (
            <div key={k} className="flex flex-col sm:flex-row sm:items-center py-1">
              <span className="w-1/3 text-xs font-semibold text-[var(--text-primary)] mb-1 sm:mb-0 capitalize">
                {k.replace(/([A-Z])/g, ' $1').trim()}
              </span>
              {data[k] !== undefined && data[k] !== "" || isEditing === k ? (
                renderFieldValue(category, k, data[k] || "")
              ) : (
                <div className="flex-1">
                  <button 
                    className="text-[var(--accent-soft)] text-[10px] uppercase font-bold px-2 py-0.5 border border-[var(--accent-soft)] hover:bg-[var(--accent-soft)] hover:text-[#07142F] transition-colors"
                    onClick={() => {
                      setIsEditing(k);
                      setEditValue("");
                    }}
                  >
                    + ADD
                  </button>
                </div>
              )}
            </div>
          ))}
          
          {/* Custom field addition block */}
          {newFieldMode === category && (
            <div className="flex items-center gap-2 mt-2 bg-[var(--surface)] p-2 border border-[var(--border)]">
              <input 
                type="text" 
                placeholder="Field Name" 
                className="w-1/3 bg-transparent text-xs text-[var(--text-primary)] border-b border-[var(--border)] focus:outline-none focus:border-[var(--accent-primary)]"
                value={newFieldName}
                onChange={e => setNewFieldName(e.target.value)}
              />
              <input 
                type="text" 
                placeholder="Value" 
                className="flex-1 bg-transparent text-xs text-[var(--text-primary)] border-b border-[var(--border)] focus:outline-none focus:border-[var(--accent-primary)]"
                value={newFieldValue}
                onChange={e => setNewFieldValue(e.target.value)}
              />
              <button 
                className="text-[var(--success)] text-[10px] font-bold"
                onClick={() => {
                  if (newFieldName.trim() && newFieldValue.trim()) {
                    handleSaveField(category, newFieldName.trim(), newFieldValue.trim());
                    setNewFieldMode(null);
                    setNewFieldName("");
                    setNewFieldValue("");
                  }
                }}
              >
                SAVE
              </button>
              <button 
                className="text-[var(--text-secondary)] text-[10px]"
                onClick={() => setNewFieldMode(null)}
              >
                CANCEL
              </button>
            </div>
          )}
          
          {!newFieldMode && category === "custom" && (
            <button 
              className="mt-2 text-[var(--accent-primary)] text-[10px] uppercase font-bold"
              onClick={() => {
                setNewFieldMode(category);
                setNewFieldName("");
                setNewFieldValue("");
              }}
            >
              + Add Custom Field
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto custom-scrollbar px-4 py-4 space-y-6 bg-[var(--background)] relative z-10">
      <div className="space-y-1 pb-2 border-b-2 border-[var(--border)]">
        <h1 className="text-2xl font-display-poster text-[var(--text-primary)] tracking-tight uppercase">
          Local <span className="text-[var(--accent-primary)]">Profile</span>
        </h1>
        <p className="text-xs font-body-editorial italic text-[var(--text-secondary)] leading-relaxed font-medium">
          Your personal information stays on this device.
        </p>
      </div>

      <div className="flex-1">
        {renderCategory("Personal", "personal", ["firstName", "lastName", "fullName", "dateOfBirth", "gender"])}
        {renderCategory("Contact", "contact", ["phone", "email"])}
        {renderCategory("Address", "address", ["addressLine1", "addressLine2", "city", "state", "country", "postalCode"])}
        {renderCategory("Identity", "identity", ["aadhaar", "pan", "passportNumber", "drivingLicenseNumber"])}
        {renderCategory("Custom Fields", "custom")}
      </div>

      <div className="pt-4 border-t border-[var(--border)] flex justify-end">
        <button 
          className="text-[var(--error)] text-xs font-bold uppercase tracking-wider px-3 py-1.5 border border-[var(--error)] hover:bg-[var(--error)] hover:text-white transition-colors"
          onClick={handleClear}
        >
          Clear Profile
        </button>
      </div>
    </div>
  );
}
