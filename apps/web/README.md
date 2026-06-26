# Welcome to your Convex + Next.js + Convex Auth app

This is a [Convex](https://convex.dev/) project created with [`npm create convex`](https://www.npmjs.com/package/create-convex).

After the initial setup (<2 minutes) you'll have a working full-stack app using:

- Convex as your backend (database, server logic)
- [React](https://react.dev/) as your frontend (web page interactivity)
- [Next.js](https://nextjs.org/) for optimized web hosting and page routing
- [Tailwind](https://tailwindcss.com/) for building great looking accessible UI
- [Convex Auth](https://labs.convex.dev/auth) for authentication
- Google Cloud Secret Manager for secure credential storage

## Google Cloud Secret Manager Setup

This project uses Google Cloud Secret Manager to securely store user credentials for various sports card platforms. Service accounts and IAM permissions are managed by Terraform in `neonbinder_terraform/`. See `CLAUDE.md` at the repo root for the full service account reference.

For local development, use SA impersonation (org policy blocks key creation):
```bash
gcloud auth application-default login \
  --impersonate-service-account=neonbinder-convex@neonbinder.iam.gserviceaccount.com
```

## Browser Service Requirement

This project uses a separate browser service for interacting with certain sports card platforms (like BuySportsCards). To test credentials for these platforms, you need to have the browser service running locally:

1. **Navigate to the browser service directory**:
   ```bash
   cd ../neonbinder_browser
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the browser service**:
   ```bash
   npm start
   ```

The browser service will run on http://localhost:8080 by default. You can configure a different URL by setting the `NEONBINDER_BROWSER_URL` environment variable in your Convex environment.

## Get started

If you just cloned this codebase and didn't use `npm create convex`, run:

```
npm install
npm run dev
```

If you're reading this README on GitHub and want to use this template, run:

```
npm create convex@latest -- -t nextjs-convexauth
```

## Testing

### Unit & component tests (vitest)

Fast inner-loop tests live next to the code they cover:

- `convex/*.test.ts`, `lib/**/*.test.ts` — backend logic via [`convex-test`](https://github.com/get-convex/convex-test) (node / edge runtime).
- `components/**/*.test.tsx` — React components via Testing Library + happy-dom.

Run them with:

```bash
npm run test:unit         # one-shot run (what CI runs)
npm run test:unit:watch   # watch mode while developing
```

These run on **every PR** via the `CI` GitHub Actions workflow (`.github/workflows/ci.yml`),
in parallel with the slower Maestro E2E suite — the unit lane is the quick gate, E2E is the full one.

> `tsc --noEmit` is not yet a CI gate (main has pre-existing type errors); run it manually for now.

### Running tests inside a git worktree

A fresh `git worktree add` has **no** `node_modules`, so `npm run test:unit` fails with
`Cannot find package 'vitest'`. If your worktree's dependencies match the primary checkout,
symlink them instead of reinstalling:

```bash
npm run link-deps     # or: ./link-deps.sh
npm run test:unit
```

`link-deps.sh` symlinks `node_modules` to the primary checkout when `package-lock.json` matches,
and refuses (telling you to `npm ci`) when dependencies have drifted.

### End-to-end tests (Maestro)

See `CLAUDE.md` (E2E Testing section) and `run-e2e-smoke.sh` for the Maestro flow suite.

## Learn more

To learn more about developing your project with Convex, check out:

- The [Tour of Convex](https://docs.convex.dev/get-started) for a thorough introduction to Convex principles.
- The rest of [Convex docs](https://docs.convex.dev/) to learn about all Convex features.
- [Stack](https://stack.convex.dev/) for in-depth articles on advanced topics.
- [Convex Auth docs](https://labs.convex.dev/auth) for documentation on the Convex Auth library.

## Configuring other authentication methods

To configure different authentication methods, see [Configuration](https://labs.convex.dev/auth/config) in the Convex Auth docs.

## Join the community

Join thousands of developers building full-stack apps with Convex:

- Join the [Convex Discord community](https://convex.dev/community) to get help in real-time.
- Follow [Convex on GitHub](https://github.com/get-convex/), star and contribute to the open-source implementation of Convex.
