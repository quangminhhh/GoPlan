import type { AIActionDraftSubmittedEdit } from './components/ActionDraftCard';
import type { ConfirmAmbiguityState } from './confirmController';
import type { AIActionDraft } from './drafts';

export interface AIActionDraftControllerLocalState {
  readonly sourceVersion: string;
  readonly draft: AIActionDraft;
  readonly feedback: string | null;
  readonly fieldErrors: Readonly<Record<string, string>> | null;
  readonly confirmState: ConfirmAmbiguityState;
  readonly retainedExpiredEdit: AIActionDraftSubmittedEdit | null;
}

export interface AIActionDraftPersistedEdit
  extends AIActionDraftSubmittedEdit {
  readonly tripId: string;
  readonly draftId: string;
  readonly submittedSourceIdentity: string;
}

export type AIActionDraftRetainedExpiredEdit =
  AIActionDraftPersistedEdit;

export interface AIActionDraftControllerSession {
  readonly localState: AIActionDraftControllerLocalState;
  readonly retainedExpiredEdit: AIActionDraftRetainedExpiredEdit | null;
  readonly editor: AIActionDraftPersistedEdit | null;
}

export interface AIActionDraftControllerSessionStore {
  readonly resourceKey: string;
  readonly get: (
    draftResourceKey: string,
  ) => AIActionDraftControllerSession | null;
  readonly set: (
    draftResourceKey: string,
    session: AIActionDraftControllerSession,
  ) => void;
  readonly delete: (draftId: string) => void;
  readonly setAmbiguousDraftIds: (draftIds: ReadonlySet<string>) => void;
}

export function createAIActionDraftControllerSessionStore(
  resourceKey: string,
): AIActionDraftControllerSessionStore {
  const sessions = new Map<string, AIActionDraftControllerSession>();
  const ambiguousDraftIds = new Set<string>();
  return {
    resourceKey,
    get: (draftResourceKey) => sessions.get(draftResourceKey) ?? null,
    set: (draftResourceKey, session) => {
      if (!ambiguousDraftIds.has(draftResourceKey)) {
        sessions.set(draftResourceKey, session);
      }
    },
    delete: (draftId) => {
      sessions.delete(draftId);
    },
    setAmbiguousDraftIds: (draftIds) => {
      ambiguousDraftIds.clear();
      for (const draftId of draftIds) {
        ambiguousDraftIds.add(draftId);
        sessions.delete(draftId);
      }
    },
  };
}
