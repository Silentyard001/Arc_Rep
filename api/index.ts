/**
 * api/index.ts
 *
 * Vercel serverless function entry point for the Arc Rep Express API.
 *
 * Vercel invokes this module per-request. It does not start a persistent
 * HTTP server — app.listen() is suppressed by the VERCEL=1 environment
 * variable set automatically by the Vercel runtime.
 *
 * The Express app is imported from server/index.ts which already exports it.
 * No application logic lives here.
 */

export { app as default } from '../server/index.js';
