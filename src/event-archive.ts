export type EventLifecycleStatus = "upcoming" | "active" | "completed";

export const ARCHIVED_EVENT_MUTATION_ERROR = "Event sudah diarsipkan dan hanya bisa dilihat.";

export function getArchiveConflict(status: EventLifecycleStatus): string | null {
  return status === "completed" ? ARCHIVED_EVENT_MUTATION_ERROR : null;
}

