import { makeDraftFixture } from '../__fixtures__/drafts';
import { createConfirmAmbiguityState } from '../confirmController';
import { createAIActionDraftControllerSessionStore } from '../controllerSession';
import { aiActionDraftSourceIdentity } from '../drafts';

describe('AI action draft controller session store', () => {
  it('rejects stale row cleanup writes while a draft id is room-ambiguous', () => {
    const draft = makeDraftFixture();
    const session = {
      localState: {
        sourceVersion: aiActionDraftSourceIdentity(draft),
        draft,
        feedback: 'Must not transfer',
        fieldErrors: null,
        confirmState: createConfirmAmbiguityState(draft),
        retainedExpiredEdit: null,
      },
      retainedExpiredEdit: null,
      editor: null,
    };
    const store = createAIActionDraftControllerSessionStore(
      'user-a:trip-a',
    );
    store.set(draft.id, session);
    expect(store.get(draft.id)).toBe(session);

    store.setAmbiguousDraftIds(new Set([draft.id]));
    expect(store.get(draft.id)).toBeNull();
    store.set(draft.id, session);
    expect(store.get(draft.id)).toBeNull();

    store.setAmbiguousDraftIds(new Set());
    store.set(draft.id, session);
    expect(store.get(draft.id)).toBe(session);
  });
});
