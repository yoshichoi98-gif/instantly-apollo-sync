/** Bindings and vars available to the Worker (see wrangler.toml). */
export interface Env {
  DB: D1Database;

  // vars
  APOLLO_USER_ID: string;
  APOLLO_SEND_ACCOUNT_ID: string;
  // Slack channel or user ID that gets bounce alerts (see slack.ts).
  SLACK_NOTIFY_CHANNEL?: string;

  // secrets
  INSTANTLY_API_KEY: string;
  APOLLO_API_KEY: string;
  ADMIN_TOKEN: string;
  SLACK_BOT_TOKEN?: string;
}
