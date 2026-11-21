/** `owner/name`: up to 39 characters of owner and 100 of name, in the characters that GitHub allows. */
export const GITHUB_REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;
