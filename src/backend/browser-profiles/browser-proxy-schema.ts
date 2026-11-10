/** Add this SQL in a new migration and to the latest schema. Do not change shipped migrations. */
export const BROWSER_PROFILE_PROXY_SCHEMA_SQL = `
CREATE TABLE browser_profile_proxies (
  profile_id TEXT PRIMARY KEY REFERENCES browser_profiles(profile_id) ON DELETE CASCADE,
  encrypted_connection TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
