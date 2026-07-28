import { describeNameError, validateHumanName } from '../nameValidation';

describe('validateHumanName', () => {
  it('accepts a single trimmed word', () => {
    expect(validateHumanName('  Quang  ')).toBeNull();
  });

  it('rejects an empty or whitespace-only value', () => {
    expect(validateHumanName('   ')).toBe('EMPTY');
  });

  it('rejects a value longer than the backend limit', () => {
    expect(validateHumanName('a'.repeat(16))).toBe('TOO_LONG');
  });

  it('accepts a value exactly at the backend limit', () => {
    expect(validateHumanName('a'.repeat(15))).toBeNull();
  });

  it('rejects an inner space', () => {
    expect(validateHumanName('Quang Minh')).toBe('HAS_SPACE');
  });
});

describe('describeNameError', () => {
  it('matches the backend copy for each code', () => {
    expect(describeNameError('First name', 'EMPTY')).toBe('First name cannot be empty.');
    expect(describeNameError('Last name', 'TOO_LONG')).toBe('Last name must be at most 15 characters.');
    expect(describeNameError('First name', 'HAS_SPACE')).toBe('First name must be a single word (no spaces).');
  });
});
