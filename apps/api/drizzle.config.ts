import { defineConfig } from 'drizzle-kit';
import { loadDotenv } from './src/lib/env.js';

loadDotenv();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/vantra' },
});
