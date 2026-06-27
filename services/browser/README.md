# Neonbinder Browser

A TypeScript-based web automation service for card delisting operations.

> **CI — per-PR preview (NEO-18):** every PR that changes `services/browser/**`
> deploys a `pr-<N>` tagged, no-traffic Cloud Run preview on the dev service and
> runs a real BSC + SportLots login probe against it (`browser.yml`). The
> top-level deployment pipeline (`pr-pipeline.yml`) then points the Convex
> preview's `NEONBINDER_BROWSER_URL` at that `pr-<N>` URL and only afterward runs
> the web Maestro E2E — so a PR is validated against its OWN browser code
> end-to-end. (Vercel never talks to the browser service; the wiring lives in the
> deployment pipeline, preserving the FE → Convex → browser boundary.)

## Features

- Express.js server with TypeScript
- Puppeteer for web automation
- Docker support
- Type-safe API endpoints

## Development

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
npm install
```

### Development Mode

```bash
npm run dev
```

This will start the server using `ts-node` for development with hot reloading.

### Building for Production

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` folder.

### Running Production Build

```bash
npm start
```

## API Endpoints

### POST /delist

Delists a card using web automation.

**Request Body:**
```json
{
  "username": "string",
  "password": "string", 
  "cardId": "string"
}
```

**Response:**
```json
{
  "success": true
}
```

## Docker

Build and run with Docker:

```bash
docker build -t neonbinder-browser .
docker run -p 8080:8080 neonbinder-browser
```

## Project Structure

```
├── src/
│   └── index.ts          # Main application file
├── dist/                 # Compiled JavaScript (generated)
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── Dockerfile           # Docker configuration
└── README.md            # This file
```

## TypeScript Configuration

The project uses strict TypeScript settings with:
- ES2020 target
- CommonJS modules
- Source maps enabled
- Declaration files generated
- Strict type checking

## Deployment

This service deploys to Cloud Run from the consolidated monorepo
(`neonbinder/neonbinder`) via `.github/workflows/browser.yml`. As of the NEO-18
cutover (2026-06-27), the monorepo is the sole deploy source of truth for the
browser service; the standalone `neonbinder_browser` repo is retired.
