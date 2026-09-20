import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { DatabaseService } from '../db/database.service';

export interface AuthUser {
  id: string;
  name: string;
  role: 'owner' | 'staff' | 'approver';
}

/**
 * 通过 x-user-id 请求头识别调用者（校园内网服务的简化身份模型）。
 * 用户须事先存在；角色由数据库而不是请求内容决定。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly db: DatabaseService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: AuthUser;
    }>();
    const userId = req.headers['x-user-id'];
    if (!userId) {
      throw new UnauthorizedException('缺少 x-user-id 请求头');
    }
    const row = this.db.get('SELECT id, name, role FROM users WHERE id = ?', userId);
    if (!row) {
      throw new UnauthorizedException(`用户不存在：${userId}`);
    }
    const user: AuthUser = {
      id: row.id as string,
      name: row.name as string,
      role: row.role as AuthUser['role'],
    };
    req.user = user;

    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && !required.includes(user.role)) {
      throw new ForbiddenException(
        `该操作需要角色：${required.join('/')}，当前为 ${user.role}`,
      );
    }
    return true;
  }
}
