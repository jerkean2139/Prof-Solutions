import pino from 'pino';
import { env } from './config/env.js';

// Structured logging. The integration contract requires every GHL and
// payment API call to be logged with request, response, and status, so a
// single shared logger is the backbone of that.
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    // Never let a secret or raw bank field reach a log line.
    paths: [
      'req.headers.authorization',
      'apiKey',
      'secret',
      'account_number',
      'routing_number',
      'accountNumber',
      'routingNumber',
    ],
    censor: '[redacted]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
