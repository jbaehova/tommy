// GitHub events of the Tommy GitHub App. GitHub sends every event of every installation to one
// Signal URL; Signal checks the App's signature and passes the event to each `ingress` socket whose
// GitHub route ticket names the repository. The account service checks, with the host's GitHub
// sign-in, that the user can see each repository before it signs the ticket, and stores nothing:
// the ticket lives for `GITHUB_ROUTE_TTL_SECONDS`, and the host asks for a new one on every
// connection. A host that loses access keeps its events until its socket connects again.

export const GITHUB_ROUTE_TTL_SECONDS = 5 * 60;

/** `owner/name`: up to 39 characters of owner and 100 of name, in the characters that GitHub allows. */
export const GITHUB_REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;
