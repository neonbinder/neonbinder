# Neonbinder Browser

A TypeScript-based web automation service for card delisting operations.

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