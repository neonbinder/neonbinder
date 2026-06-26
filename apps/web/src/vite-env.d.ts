/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONVEX_URL: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY: string;
  readonly VITE_POSTHOG_KEY: string;
  readonly VITE_POSTHOG_HOST: string;
  readonly VITE_SENTRY_DSN: string;
  readonly VITE_APP_VERSION: string;
  readonly VITE_ENVIRONMENT: string;
  readonly VITE_CLERK_TESTING_ENABLED: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
