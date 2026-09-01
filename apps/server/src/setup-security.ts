import { createHash, timingSafeEqual } from "node:crypto";

export const INITIAL_SETUP_TOKEN_MIN_LENGTH = 24;

function secretMatches(provided: string, expected: string) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

export function initialSetupProtection(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const token = String(environment.INITIAL_SETUP_TOKEN || "").trim();
  const required = environment.NODE_ENV === "production";
  return {
    required,
    configured: !required || token.length >= INITIAL_SETUP_TOKEN_MIN_LENGTH,
    token,
  };
}

export function assertInitialSetupAuthorized(
  provided: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const protection = initialSetupProtection(environment);
  if (!protection.required) return;
  if (!protection.configured)
    throw Object.assign(
      new Error(
        `Initial setup is locked. Configure INITIAL_SETUP_TOKEN with at least ${INITIAL_SETUP_TOKEN_MIN_LENGTH} characters on the server first.`,
      ),
      { statusCode: 503 },
    );
  if (!provided || !secretMatches(provided, protection.token))
    throw Object.assign(new Error("Invalid initial setup code"), {
      statusCode: 403,
    });
}
