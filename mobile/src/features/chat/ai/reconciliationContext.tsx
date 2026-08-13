import {
  createContext,
  type PropsWithChildren,
  useContext,
  useMemo,
} from 'react';
import {
  createAIActionDraftControllerSessionStore,
  type AIActionDraftControllerSessionStore,
} from './controllerSession';
import type { AIReconciliationCoordinator } from './reconciliation';

const AIReconciliationCoordinatorContext =
  createContext<AIReconciliationCoordinator | null>(null);
const AIActionDraftControllerSessionContext =
  createContext<AIActionDraftControllerSessionStore | null>(null);

export function AIReconciliationCoordinatorProvider({
  children,
  value,
}: PropsWithChildren<{
  readonly value: AIReconciliationCoordinator | null;
}>) {
  const resourceKey = value?.resourceKey ?? null;
  const controllerSessionStore = useMemo(
    () =>
      resourceKey === null
        ? null
        : createAIActionDraftControllerSessionStore(resourceKey),
    [resourceKey],
  );
  return (
    <AIReconciliationCoordinatorContext.Provider value={value}>
      <AIActionDraftControllerSessionContext.Provider
        value={controllerSessionStore}
      >
        {children}
      </AIActionDraftControllerSessionContext.Provider>
    </AIReconciliationCoordinatorContext.Provider>
  );
}

export function useRoomAIReconciliationCoordinator(): AIReconciliationCoordinator | null {
  return useContext(AIReconciliationCoordinatorContext);
}

export function useRoomAIActionDraftControllerSessionStore(): AIActionDraftControllerSessionStore | null {
  return useContext(AIActionDraftControllerSessionContext);
}
