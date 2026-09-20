import { randomUUID, createHash } from 'crypto';
import { DomainError } from './errors';
import { toIso } from '../domain/time';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function requireString(body: any, field: string): string {
  const v = body?.[field];
  if (typeof v !== 'string' || v.trim() === '') {
    throw DomainError.badRequest(`字段 ${field} 必须为非空字符串`);
  }
  return v.trim();
}

export function optionalString(body: any, field: string): string | null {
  const v = body?.[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw DomainError.badRequest(`字段 ${field} 必须为字符串`);
  return v.trim();
}

export function requireInt(body: any, field: string, min = 0): number {
  const v = body?.[field];
  if (!Number.isInteger(v) || v < min) {
    throw DomainError.badRequest(`字段 ${field} 必须为不小于 ${min} 的整数`);
  }
  return v;
}

export function requireBool(body: any, field: string): boolean {
  const v = body?.[field];
  if (typeof v !== 'boolean') throw DomainError.badRequest(`字段 ${field} 必须为布尔值`);
  return v;
}

export function optionalBool(body: any, field: string, fallback: boolean): boolean {
  const v = body?.[field];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw DomainError.badRequest(`字段 ${field} 必须为布尔值`);
  return v;
}

export function requireStringArray(body: any, field: string): string[] {
  const v = body?.[field];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) {
    throw DomainError.badRequest(`字段 ${field} 必须为非空字符串数组`);
  }
  return v.map((x: string) => x.trim());
}

export function optionalStringArray(body: any, field: string): string[] {
  const v = body?.[field];
  if (v === undefined || v === null) return [];
  return requireStringArray(body, field);
}

export function requireIso(body: any, field: string): string {
  const iso = toIso(body?.[field]);
  if (!iso) throw DomainError.badRequest(`字段 ${field} 必须为合法的时间（ISO 8601）`);
  return iso;
}
