// SPDX-License-Identifier: GPL-3.0-or-later
export class ApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export class NotFoundError extends ApplicationError {
  constructor(message: string) {
    super('not_found', message, 404);
  }
}

export class UnauthorizedError extends ApplicationError {
  constructor(message = 'Authentication is required') {
    super('unauthorized', message, 401);
  }
}

export class ConflictError extends ApplicationError {
  constructor(message: string) {
    super('conflict', message, 409);
  }
}

export class CapacityError extends ApplicationError {
  constructor(message: string) {
    super('capacity_exceeded', message, 503);
  }
}
