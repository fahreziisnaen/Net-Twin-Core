// Placeholder values that ship in .env.example and older docker-compose
// defaults. They are public, so in production they are as good as no secret.
const PLACEHOLDERS = new Set([
  'change-me-in-production',
  'change-me-collector-token',
  'nettwin-dev-secret-change-me',
  'nettwin-dev-cred-key-change-me',
]);

export const MIN_SECRET_LENGTH = 16;

// True when a secret is missing, too short to resist guessing, or a known placeholder.
export function isWeakSecret(value: string | undefined): boolean {
  return !value || value.length < MIN_SECRET_LENGTH || PLACEHOLDERS.has(value);
}
