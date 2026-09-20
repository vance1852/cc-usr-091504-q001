import { Global, Module, DynamicModule } from '@nestjs/common';
import { DatabaseService, DB_FILE } from './database.service';

@Global()
@Module({})
export class DatabaseModule {
  static forFile(dbFile: string): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: DB_FILE, useValue: dbFile },
        DatabaseService,
      ],
      exports: [DatabaseService],
    };
  }
}
