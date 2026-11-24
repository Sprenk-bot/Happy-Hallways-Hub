export type HubMailRecipient = {
  staffId: string;
  displayName: string;
  role: "ea" | "tic";
};
export type HubMailReply = { id: string; senderStaffId: string; senderDisplayName: string; note: string; submittedAt: string };

export type HubConcernScope = "tic" | "all-staff" | "selected";
export type HubConcernPolicy = {
  availableScopes: HubConcernScope[];
  defaultScope: HubConcernScope;
  updatedAt: string;
};

export type HubMailMessage = {
  id: string;
  visitId: string;
  studentId: string;
  studentName: string;
  destinationLabel: string;
  senderStaffId: string;
  senderDisplayName: string;
  scope: "tic" | "all-staff" | "selected";
  note: string;
  submittedAt: string;
  recipients: HubMailRecipient[];
  isSender: boolean;
  isRecipient: boolean;
  isTicOversight: boolean;
  readAt: string | null;
  replies: HubMailReply[];
  archivedAt: string | null;
};

export const hubMail = $state({
  messages: [] as HubMailMessage[],
  recipients: [] as HubMailRecipient[],
  concernPolicy: {
    availableScopes: ["tic", "all-staff", "selected"] as HubConcernScope[],
    defaultScope: "tic" as HubConcernScope,
    updatedAt: "",
  },
  concernPolicyLoaded: false,
  concernPolicyError: "",
  unreadCount: 0,
  alertCount: 0,
  lastCheckedAt: null as string | null,
  error: "",
  recipientsError: "",
  recipientsLoaded: false,
});

let pollTimer: ReturnType<typeof setInterval> | null = null;
let seenInitialized = false;
let seenMessageIds = new Set<string>();
let requestGeneration = 0;

export async function refreshHubMail() {
  const generation = requestGeneration;
  try {
    const response = await fetch("/api/v1/mail", {
      headers: { Accept: "application/json" },
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      throw new Error(mailError(payload, "The Mail Centre could not be refreshed."));
    }
    if (!isMailResponse(payload)) {
      throw new Error("The Hub Host returned an invalid Mail Centre response.");
    }
    if (generation !== requestGeneration) return false;

    const newUnread = payload.messages.filter(
      (message) =>
        message.isRecipient &&
        !message.readAt &&
        !seenMessageIds.has(message.id),
    );
    if (seenInitialized && newUnread.length) {
      hubMail.alertCount = newUnread.length;
    }
    seenInitialized = true;
    seenMessageIds = new Set(payload.messages.map((message) => message.id));
    hubMail.messages = payload.messages;
    hubMail.unreadCount = payload.unreadCount;
    hubMail.lastCheckedAt = new Date().toISOString();
    hubMail.error = "";
    return true;
  } catch (error) {
    if (generation !== requestGeneration) return false;
    hubMail.error =
      error instanceof Error
        ? error.message
        : "The Mail Centre could not be refreshed.";
    return false;
  }
}

export async function loadMailRecipients() {
  const generation = requestGeneration;
  try {
    const response = await fetch("/api/v1/mail/recipients", {
      headers: { Accept: "application/json" },
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      throw new Error(mailError(payload, "Staff routing choices could not be loaded."));
    }
    if (
      !isRecord(payload) ||
      !Array.isArray(payload.recipients) ||
      !payload.recipients.every(isMailRecipient)
    ) {
      throw new Error("The Hub Host returned invalid staff routing choices.");
    }
    if (generation !== requestGeneration) return false;
    hubMail.recipients = payload.recipients;
    hubMail.recipientsLoaded = true;
    hubMail.recipientsError = "";
    return true;
  } catch (error) {
    if (generation !== requestGeneration) return false;
    hubMail.recipientsLoaded = false;
    hubMail.recipientsError =
      error instanceof Error
        ? error.message
        : "Staff routing choices could not be loaded.";
    return false;
  }
}

export async function loadHubConcernPolicy() {
  const generation = requestGeneration;
  try {
    const response = await fetch("/api/v1/concerns/settings", {
      headers: { Accept: "application/json" },
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      throw new Error(mailError(payload, "Concern routing settings could not be loaded."));
    }
    if (!isHubConcernPolicy(payload)) {
      throw new Error("The Hub Host returned invalid concern routing settings.");
    }
    if (generation !== requestGeneration) return false;
    hubMail.concernPolicy = payload;
    hubMail.concernPolicyLoaded = true;
    hubMail.concernPolicyError = "";
    return true;
  } catch (error) {
    if (generation !== requestGeneration) return false;
    hubMail.concernPolicyLoaded = false;
    hubMail.concernPolicyError =
      error instanceof Error
        ? error.message
        : "Concern routing settings could not be loaded.";
    return false;
  }
}

export async function sendHubConcern(input: {
  visitId: string;
  note: string;
  scope: "tic" | "all-staff" | "selected";
  recipientIds: string[];
}) {
  const generation = requestGeneration;
  const response = await fetch("/api/v1/concerns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(mailError(payload, "The concern could not be saved to the Hub Host."));
  }
  if (!isMailMessage(payload)) {
    throw new Error("The Hub Host returned an invalid concern receipt.");
  }
  if (generation !== requestGeneration) {
    throw new Error("Your staff session changed before the concern was confirmed.");
  }
  await refreshHubMail();
  return payload;
}

export async function markHubMailRead(messageId: string) {
  const generation = requestGeneration;
  const response = await fetch(
    `/api/v1/mail/${encodeURIComponent(messageId)}/read`,
    { method: "POST" },
  );
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(mailError(payload, "The message could not be marked as read."));
  }
  if (!isRecord(payload) || typeof payload.readAt !== "string") {
    throw new Error("The Hub Host returned an invalid read receipt.");
  }
  if (generation !== requestGeneration) {
    throw new Error("Your staff session changed before the read receipt arrived.");
  }
  await refreshHubMail();
}

export async function replyToHubMail(messageId: string, note: string) {
  const response = await fetch(`/api/v1/mail/${encodeURIComponent(messageId)}/replies`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error(mailError(payload, "Your reply could not be saved."));
  await refreshHubMail();
}

export async function archiveHubMail(messageId: string, archived: boolean) {
  const response = await fetch(`/api/v1/mail/${encodeURIComponent(messageId)}/archive`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error(mailError(payload, "The message could not be archived."));
  await refreshHubMail();
}

export function dismissHubMailAlert() {
  hubMail.alertCount = 0;
}

export function startHubMailPolling() {
  if (pollTimer) return;
  requestGeneration++;
  seenInitialized = false;
  seenMessageIds = new Set();
  void refreshHubMail();
  void loadHubConcernPolicy();
  pollTimer = setInterval(() => {
    void refreshHubMail();
    void loadHubConcernPolicy();
  }, 4000);
}

export function stopHubMailPolling() {
  requestGeneration++;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  seenInitialized = false;
  seenMessageIds = new Set();
  hubMail.messages = [];
  hubMail.unreadCount = 0;
  hubMail.alertCount = 0;
  hubMail.lastCheckedAt = null;
  hubMail.error = "";
  hubMail.recipients = [];
  hubMail.recipientsLoaded = false;
  hubMail.recipientsError = "";
  hubMail.concernPolicy = {
    availableScopes: ["tic", "all-staff", "selected"],
    defaultScope: "tic",
    updatedAt: "",
  };
  hubMail.concernPolicyLoaded = false;
  hubMail.concernPolicyError = "";
}

function isMailResponse(
  value: unknown,
): value is { messages: HubMailMessage[]; unreadCount: number } {
  return (
    isRecord(value) &&
    Array.isArray(value.messages) &&
    value.messages.every(isMailMessage) &&
    Number.isSafeInteger(value.unreadCount) &&
    Number(value.unreadCount) >= 0
  );
}

function isMailMessage(value: unknown): value is HubMailMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.visitId === "string" &&
    typeof value.studentId === "string" &&
    typeof value.studentName === "string" &&
    typeof value.destinationLabel === "string" &&
    typeof value.senderStaffId === "string" &&
    typeof value.senderDisplayName === "string" &&
    (value.scope === "tic" ||
      value.scope === "all-staff" ||
      value.scope === "selected") &&
    typeof value.note === "string" &&
    typeof value.submittedAt === "string" &&
    Array.isArray(value.recipients) &&
    value.recipients.every(isMailRecipient) &&
    typeof value.isSender === "boolean" &&
    typeof value.isRecipient === "boolean" &&
    typeof value.isTicOversight === "boolean" &&
    (value.readAt === null || typeof value.readAt === "string")
    && Array.isArray(value.replies) && value.replies.every(isMailReply)
    && (value.archivedAt === null || typeof value.archivedAt === "string")
  );
}

function isMailReply(value: unknown): value is HubMailReply {
  return isRecord(value) && typeof value.id === "string" && typeof value.senderStaffId === "string" && typeof value.senderDisplayName === "string" && typeof value.note === "string" && typeof value.submittedAt === "string";
}

function isMailRecipient(value: unknown): value is HubMailRecipient {
  return (
    isRecord(value) &&
    typeof value.staffId === "string" &&
    typeof value.displayName === "string" &&
    (value.role === "ea" || value.role === "tic")
  );
}

function isHubConcernPolicy(value: unknown): value is HubConcernPolicy {
  return (
    isRecord(value) &&
    Array.isArray(value.availableScopes) &&
    value.availableScopes.length > 0 &&
    value.availableScopes.length <= 3 &&
    value.availableScopes.every(isHubConcernScope) &&
    new Set(value.availableScopes).size === value.availableScopes.length &&
    isHubConcernScope(value.defaultScope) &&
    value.availableScopes.includes(value.defaultScope) &&
    typeof value.updatedAt === "string"
  );
}

function isHubConcernScope(value: unknown): value is HubConcernScope {
  return value === "tic" || value === "all-staff" || value === "selected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mailError(value: unknown, fallback: string) {
  if (!isRecord(value) || typeof value.error !== "string") return fallback;
  const messages: Record<string, string> = {
    staff_session_required: "Sign in again to use the Mail Centre.",
    role_not_allowed: "This action is not available to this staff profile.",
    record_not_found: "That message or movement could not be found.",
    invalid_hub_concern_request: "Check the concern details and try again.",
    revision_conflict: "The Hub Host changed. Refresh and try again.",
    state_integrity_failed: "The Hub Host could not verify the saved account.",
  };
  return messages[value.error] ?? fallback;
}
