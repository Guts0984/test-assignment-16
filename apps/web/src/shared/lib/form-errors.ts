// Forms show errors at their fields (ASSIGNMENT): the api's field errors map onto form fields.
import { type ApiError, isApiError } from '../api/mutator';

export type FieldErrorSetter = (name: string, error: { type: string; message: string }) => void;

/** Applies field errors from a VALIDATION_FAILED response; returns the message for the form-level banner otherwise. */
export const applyApiErrors = (
  e: unknown,
  setError: FieldErrorSetter,
  known: readonly string[],
): string | null => {
  if (!isApiError(e)) return 'Could not reach the server. Try again.';
  const fields = e.body.fields ?? [];
  const unmatched = fields.filter((f) => !known.includes(f.path.split('.')[0] ?? ''));
  for (const f of fields) {
    const root = f.path.split('.')[0] ?? '';
    if (known.includes(root)) setError(f.path, { type: f.code, message: f.message });
  }
  if (fields.length > 0 && unmatched.length === 0) return null;
  return e.body.message;
};

export const messageOf = (e: unknown): string =>
  isApiError(e) ? e.body.message : 'Could not reach the server. Try again.';
export const codeOf = (e: unknown): string => (isApiError(e) ? e.body.code : 'NETWORK');
export type { ApiError };
