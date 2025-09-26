import { NextResponse } from 'next/server';

export class HttpError extends Error {
  public readonly status: number;
  public readonly details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends HttpError {
  constructor(message = 'Invalid input', details?: unknown) {
    super(message, 400, details);
  }
}

export class RateLimitError extends HttpError {
  constructor(message = 'Rate limit exceeded', details?: unknown) {
    super(message, 429, details);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Not found', details?: unknown) {
    super(message, 404, details);
  }
}

export class InternalServerError extends HttpError {
  constructor(message = 'Internal server error', details?: unknown) {
    super(message, 500, details);
  }
}

export function errorResponse(error: unknown, fallbackStatus = 500) {
  if (error instanceof HttpError) {
    return NextResponse.json({ error: error.message, ...(error.details ? { details: error.details } : {}) }, { status: error.status });
  }
  const message = (error as Error)?.message || 'Internal server error';
  return NextResponse.json({ error: 'Internal server error', details: message }, { status: fallbackStatus });
}


