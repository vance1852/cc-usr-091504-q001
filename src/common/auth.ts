import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser, Role } from '../domain/types';
import { DomainError } from './errors';

/**
 * 简化身份模型：请求头 x-user-id / x-user-role（organizer|staff|approver）。
 * - organizer 活动负责人：只能修改本人项目
 * - staff     总务人员：管理场地状态、封闭、通知派发
 * - approver  审批人：消防容量/特殊通行例外批准
 */
export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const id = req.headers['x-user-id'];
    if (!id || typeof id !== 'string') {
      throw DomainError.unauthorized();
    }
    const rawRole = (req.headers['x-user-role'] as string) || 'organizer';
    if (!['organizer', 'staff', 'approver'].includes(rawRole)) {
      throw DomainError.badRequest(`未知角色：${rawRole}`);
    }
    const user: AuthUser = { id, role: rawRole as Role };
    req.user = user;

    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (required && required.length > 0 && !required.includes(user.role)) {
      throw DomainError.forbidden(`该操作需要角色：${required.join(' / ')}`);
    }
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    return ctx.switchToHttp().getRequest().user;
  },
);
