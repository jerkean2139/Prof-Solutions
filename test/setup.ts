// Test defaults. Point at a local Postgres and Redis unless the environment
// already provides them (CI can override). Set before any src module imports
// env.ts, which validates these on load.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgres://postgres@127.0.0.1:5432/profsol';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.AUTH_ENFORCED ||= 'false';
process.env.LOG_LEVEL ||= 'silent';
