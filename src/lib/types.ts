export type RunStatus = 'waiting_child' | 'waiting_parent' | 'confirmed' | 'cancelled';

export interface TaskConfig {
  enabled: boolean;
  id: string;
  title: string;
  message: string;
  weekday: number;
  time: string;
  childReplyId: string;
  parentReplyId: string;
  childSendNumber: string;
  parentSendNumber: string;
  childReminderHours: number;
  parentReminderHours: number;
  childKeywords: string[];
  parentKeywords: string[];
}

export interface ActiveRun {
  runId: string;
  taskId: string;
  refCode: string;
  status: RunStatus;
  reason: 'schedule' | 'manual';
  scheduledDate: string;
  startedAt: string;
  childDoneAt?: string;
  parentConfirmedAt?: string;
  lastChildSendAt?: string;
  lastParentSendAt?: string;
  childReminderCount: number;
  parentReminderCount: number;
}

export interface IncomingMessage {
  from: string;
  text: string;
  timestamp: number;
  messageId?: string;
  raw?: Record<string, unknown>;
}

export interface HistoryEntry {
  timestamp: string;
  type: 'started' | 'child_done' | 'parent_confirmed' | 'cancelled' | 'child_reminder' | 'parent_reminder';
  taskId: string;
  refCode: string;
  status: RunStatus | 'idle';
  details?: string;
}

export interface TaskMemory {
  lastScheduleDate?: string;
}

export interface KnownParticipant {
  id: string;
  displayName: string;
  phoneNumber?: string;
  sourceType?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
}

export interface PersistedStore {
  runs: Record<string, ActiveRun>;
  taskMemory: Record<string, TaskMemory>;
  history: HistoryEntry[];
  knownParticipants: Record<string, KnownParticipant>;
  lastMessageFingerprint?: string;
}

export interface AdapterConfig {
  openWaInstance: string;
  incomingStateId: string;
  historyLimit: number;
  logIncomingMessages: boolean;
  replyLinkPhone: string;
  tasks: Array<Record<string, unknown>>;
}
