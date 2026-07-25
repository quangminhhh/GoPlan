import {
  DEFAULT_TIMELINE_COLOR_TOKEN,
  DEFAULT_TIMELINE_ICON_KEY,
  isTimelineColorToken,
  isTimelineIconKey,
} from './tokenMaps';
import type {
  CreateCustomTypePayload,
  PatchCustomTypePayload,
  TimelineCustomTypeMeta,
} from './types';

export const CUSTOM_TYPE_NAME_MAX_LENGTH = 40;

export interface CustomTypeDraft {
  name: string;
  color_token: string;
  icon_key: string;
}

export type CustomTypeField = keyof CustomTypeDraft;
export type CustomTypeFieldErrors = Partial<
  Record<CustomTypeField, string>
>;

export interface CustomTypeValidationResult {
  isValid: boolean;
  fieldErrors: CustomTypeFieldErrors;
}

function normalizeName(value: string): string {
  return value.trim();
}

export function createCustomTypeDraft(): CustomTypeDraft {
  return {
    name: '',
    color_token: DEFAULT_TIMELINE_COLOR_TOKEN,
    icon_key: DEFAULT_TIMELINE_ICON_KEY,
  };
}

export function hydrateCustomTypeDraft(
  customType: TimelineCustomTypeMeta,
): CustomTypeDraft {
  return {
    name: customType.name,
    color_token: customType.color_token,
    icon_key: customType.icon_key,
  };
}

export function validateCustomTypeDraft(
  draft: CustomTypeDraft,
): CustomTypeValidationResult {
  const fieldErrors: CustomTypeFieldErrors = {};
  const name = normalizeName(draft.name);

  if (!name) {
    fieldErrors.name = 'Name is required.';
  } else if (Array.from(name).length > CUSTOM_TYPE_NAME_MAX_LENGTH) {
    fieldErrors.name =
      `Name must be ${CUSTOM_TYPE_NAME_MAX_LENGTH} characters or fewer.`;
  }

  return {
    isValid: Object.keys(fieldErrors).length === 0,
    fieldErrors,
  };
}

export function buildCreateCustomTypePayload(
  draft: CustomTypeDraft,
): CreateCustomTypePayload | null {
  if (
    !validateCustomTypeDraft(draft).isValid ||
    !isTimelineColorToken(draft.color_token) ||
    !isTimelineIconKey(draft.icon_key)
  ) {
    return null;
  }

  return {
    name: normalizeName(draft.name),
    color_token: draft.color_token,
    icon_key: draft.icon_key,
  };
}

export function buildPatchCustomTypePayload(
  initialDraft: CustomTypeDraft,
  draft: CustomTypeDraft,
): PatchCustomTypePayload | null {
  if (!validateCustomTypeDraft(draft).isValid) {
    return null;
  }

  const payload: PatchCustomTypePayload = {};
  const initialName = normalizeName(initialDraft.name);
  const currentName = normalizeName(draft.name);

  if (initialName !== currentName) {
    payload.name = currentName;
  }
  if (
    initialDraft.color_token !== draft.color_token &&
    isTimelineColorToken(draft.color_token)
  ) {
    payload.color_token = draft.color_token;
  }
  if (
    initialDraft.icon_key !== draft.icon_key &&
    isTimelineIconKey(draft.icon_key)
  ) {
    payload.icon_key = draft.icon_key;
  }

  return payload;
}
