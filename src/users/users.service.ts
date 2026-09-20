import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { UserRole } from '../domain/types';

@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}

  upsert(id: string, name: string, role: UserRole): void {
    this.db.run(
      `INSERT INTO users (id, name, role) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role`,
      id,
      name,
      role,
    );
  }

  get(id: string) {
    return this.db.get('SELECT id, name, role FROM users WHERE id = ?', id);
  }

  list() {
    return this.db.all('SELECT id, name, role FROM users ORDER BY id');
  }

  count(): number {
    const row = this.db.get('SELECT COUNT(*) AS c FROM users');
    return Number(row?.c ?? 0);
  }

  /**
   * 首次启动引导：系统中还没有任何用户时，登记一位初始总务人员，
   * 之后用户管理一律走鉴权接口。
   */
  bootstrapInitialStaff(id: string, name: string): boolean {
    if (this.count() > 0) return false;
    this.upsert(id, name, 'staff');
    return true;
  }

  /** 初始化辅助：批量创建用户 */
  seed(users: Array<{ id: string; name: string; role: UserRole }>): void {
    for (const u of users) this.upsert(u.id, u.name, u.role);
  }
}
