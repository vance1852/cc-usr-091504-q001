import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { SCHEMA_SQL } from './schema';
import { openDatabase, SqliteConnection } from './sqlite';

/**
 * SQLite 持久化（Node 内置 node:sqlite，同步驱动）。
 * 同步驱动配合 Node 单线程事件循环，事务内的读写不会与其他请求交错；
 * tx() 支持嵌套（内层直接并入外层事务），保证确认/迁移等复合写操作的原子性，
 * 从而避免并发确认造成双重占用。
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private db: SqliteConnection;
  private txDepth = 0;

  onModuleInit() {
    const path = process.env.DATABASE_PATH || './data/campus.db';
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = openDatabase(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA_SQL);
  }

  onModuleDestroy() {
    this.db?.close();
  }

  get conn(): SqliteConnection {
    return this.db;
  }

  /** 在单个事务中执行 fn；任一语句抛错即整体回滚。嵌套调用并入外层事务。 */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      return fn();
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.txDepth--;
    }
  }
}
