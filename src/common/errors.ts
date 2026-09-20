import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

/** 领域错误：携带 HTTP 状态码、机器可读 code 与结构化细节（如冲突依据） */
export class DomainError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  static badRequest(message: string, details?: unknown) {
    return new DomainError(HttpStatus.BAD_REQUEST, 'VALIDATION', message, details);
  }
  static notFound(message: string, details?: unknown) {
    return new DomainError(HttpStatus.NOT_FOUND, 'NOT_FOUND', message, details);
  }
  static forbidden(message: string, details?: unknown) {
    return new DomainError(HttpStatus.FORBIDDEN, 'FORBIDDEN', message, details);
  }
  static conflict(message: string, details?: unknown) {
    return new DomainError(HttpStatus.CONFLICT, 'CONFLICT', message, details);
  }
  static unauthorized(message = '缺少身份标识（x-user-id）') {
    return new DomainError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', message);
  }
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof DomainError) {
      res.status(exception.statusCode).json({
        statusCode: exception.statusCode,
        code: exception.code,
        message: exception.message,
        details: exception.details ?? null,
      });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(
        typeof body === 'object' ? body : { statusCode: status, message: body },
      );
      return;
    }
    // eslint-disable-next-line no-console
    console.error(exception);
    res.status(500).json({ statusCode: 500, code: 'INTERNAL', message: '内部错误' });
  }
}
