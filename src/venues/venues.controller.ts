import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { VenuesService } from './venues.service';
import { AuthGuard, CurrentUser, Roles } from '../common/auth';
import { AuthUser } from '../domain/types';
import { DomainError } from '../common/errors';
import {
  optionalBool,
  optionalString,
  optionalStringArray,
  requireInt,
  requireString,
} from '../common/validate';
import { isValidWindow } from '../domain/time';

@Controller('venues')
@UseGuards(AuthGuard)
export class VenuesController {
  constructor(private readonly venues: VenuesService) {}

  /** 总务登记场地 */
  @Post()
  @Roles('staff')
  create(@Body() body: any, @CurrentUser() user: AuthUser) {
    const windows = body?.windows;
    if (!Array.isArray(windows) || windows.length === 0 || !windows.every(isValidWindow)) {
      throw DomainError.badRequest('字段 windows 必须为合法的可用时段数组');
    }
    return this.venues.create({
      name: requireString(body, 'name'),
      capacity: requireInt(body, 'capacity', 1),
      accessible: optionalBool(body, 'accessible', true),
      equipment: optionalStringArray(body, 'equipment'),
      windows,
      turnoverMinutes: body?.turnoverMinutes === undefined ? 30 : requireInt(body, 'turnoverMinutes', 0),
      actorId: user.id,
    });
  }

  @Get()
  list() {
    return this.venues.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.venues.get(id);
  }

  /** 场地版本历史：每次确认所依据的版本都可在此查到完整快照 */
  @Get(':id/versions')
  versions(@Param('id') id: string) {
    return this.venues.versions(id);
  }

  /** 总务维护场地状态与属性；影响安排的变更自动升版本 */
  @Patch(':id')
  @Roles('staff')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: AuthUser) {
    const patch: any = {};
    if (body?.name !== undefined) patch.name = requireString(body, 'name');
    if (body?.capacity !== undefined) patch.capacity = requireInt(body, 'capacity', 1);
    if (body?.accessible !== undefined) patch.accessible = optionalBool(body, 'accessible', true);
    if (body?.equipment !== undefined) patch.equipment = optionalStringArray(body, 'equipment');
    if (body?.windows !== undefined) {
      if (!Array.isArray(body.windows) || !body.windows.every(isValidWindow)) {
        throw DomainError.badRequest('字段 windows 必须为合法的可用时段数组');
      }
      patch.windows = body.windows;
    }
    if (body?.turnoverMinutes !== undefined) {
      patch.turnoverMinutes = requireInt(body, 'turnoverMinutes', 0);
    }
    if (body?.status !== undefined) {
      if (!['OPEN', 'CLOSED'].includes(body.status)) {
        throw DomainError.badRequest('status 只能为 OPEN 或 CLOSED');
      }
      patch.status = body.status;
    }
    if (Object.keys(patch).length === 0) {
      throw DomainError.badRequest('没有需要更新的字段');
    }
    const reason = optionalString(body, 'changeReason') ?? '场地信息更新';
    return this.venues.update(id, patch, user.id, reason);
  }
}
