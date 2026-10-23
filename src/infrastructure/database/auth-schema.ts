export const AUTH_SCHEMA_STATEMENTS = [
  `CREATE TABLE agent_models_user (
    id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, "emailVerified" boolean NOT NULL DEFAULT false,
    image text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE agent_models_session (
    id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
    "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), "ipAddress" text, "userAgent" text,
    "userId" text NOT NULL REFERENCES agent_models_user(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX agent_models_session_user_idx ON agent_models_session("userId")`,
  `CREATE TABLE agent_models_account (
    id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL, issuer text,
    "userId" text NOT NULL REFERENCES agent_models_user(id) ON DELETE CASCADE,
    "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz,
    "refreshTokenExpiresAt" timestamptz, scope text, password text,
    "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("providerId","accountId")
  )`,
  `CREATE INDEX agent_models_account_user_idx ON agent_models_account("userId")`,
  `CREATE TABLE agent_models_verification (
    id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, "expiresAt" timestamptz NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX agent_models_verification_identifier_idx ON agent_models_verification(identifier)`,
] as const;
