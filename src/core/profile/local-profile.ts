// ============================================================
// KAMNAA — Local Profile Vault
// Stores personal information 100% locally on the device.
// This data MUST NOT be sent to LLM providers.
// ============================================================

export interface KamnaaProfile {
  version: number;
  personal: {
    firstName?: string;
    middleName?: string;
    lastName?: string;
    fullName?: string;
    dateOfBirth?: string;
    gender?: string;
  };
  contact: {
    phone?: string;
    email?: string;
  };
  address: {
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    state?: string;
    country?: string;
    postalCode?: string;
  };
  identity: {
    aadhaar?: string;
    pan?: string;
    passportNumber?: string;
    drivingLicenseNumber?: string;
  };
  custom: Record<string, string>;
}

const STORAGE_KEY = "kamnaa_local_profile";

/** Create an empty profile structure */
export function createEmptyProfile(): KamnaaProfile {
  return {
    version: 1,
    personal: {},
    contact: {},
    address: {},
    identity: {},
    custom: {},
  };
}

/** Retrieve the profile from local storage. */
export async function loadProfile(): Promise<KamnaaProfile> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return (globalThis as any).__kamnaa_profile_memory__ || createEmptyProfile();
    }
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return data[STORAGE_KEY] || createEmptyProfile();
  } catch (err) {
    console.error("[KAMNAA Profile] Failed to load profile");
    return createEmptyProfile();
  }
}

/** Save the entire profile into local storage. */
export async function saveProfile(profile: KamnaaProfile): Promise<void> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      (globalThis as any).__kamnaa_profile_memory__ = profile;
      return;
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: profile });
  } catch (err) {
    console.error("[KAMNAA Profile] Failed to save profile");
  }
}

/** Clear all saved profile history. */
export async function clearProfile(): Promise<void> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      (globalThis as any).__kamnaa_profile_memory__ = createEmptyProfile();
      return;
    }
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch (err) {
    console.error("[KAMNAA Profile] Failed to clear profile");
  }
}

/** Helper to update a specific category and field */
export async function updateProfileField(
  category: keyof Omit<KamnaaProfile, "version">,
  field: string,
  value: string
): Promise<void> {
  const profile = await loadProfile();
  if (!profile[category]) {
    (profile as any)[category] = {};
  }
  (profile[category] as any)[field] = value;
  await saveProfile(profile);
}

/** Flatten the profile into a single key-value store for easy matching. */
export function flattenProfile(profile: KamnaaProfile): Record<string, string> {
  return {
    ...profile.personal,
    ...profile.contact,
    ...profile.address,
    ...profile.identity,
    ...profile.custom,
  };
}

/** 
 * Returns true if the given key is considered sensitive.
 * This is used by the UI and logging layers to mask output.
 */
export function isFieldSensitive(key: string): boolean {
  const sensitiveKeys = new Set([
    "aadhaar",
    "pan",
    "passportNumber",
    "drivingLicenseNumber",
    "accountNumber",
    "upiId",
    "ifsc"
  ]);
  return sensitiveKeys.has(key);
}
