import dotenv from 'dotenv';

// Imported first by server.ts: other modules read process.env while loading
// (e.g. JWT_SECRET in auth.ts), so .env must be applied before they evaluate.
// Variables already set in the real environment (docker-compose) take precedence.
dotenv.config({ quiet: true });
