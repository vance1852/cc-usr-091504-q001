import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ScheduleService } from './schedule.service';
import { AuthGuard } from '../common/auth';
import { toIso } from '../domain/time';
import { DomainError } from '../common/errors';

@Controller('schedule')
@UseGuards(AuthGuard)
export class ScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  /** 任一时段总览：实际使用者、待清场事项、冲突依据、受影响人群、变更通知状态 */
  @Get()
  overview(@Query('from') from?: string, @Query('to') to?: string, @Query('venueId') venueId?: string) {
    const fromIso = from ? toIso(from) : null;
    const toIsoV = to ? toIso(to) : null;
    if (from && !fromIso) throw DomainError.badRequest('from 必须为合法时间');
    if (to && !toIsoV) throw DomainError.badRequest('to 必须为合法时间');
    const now = new Date();
    const effectiveFrom = fromIso ?? new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const effectiveTo = toIsoV ?? new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();
    if (!(effectiveFrom < effectiveTo)) throw DomainError.badRequest('from 必须早于 to');
    return this.schedule.overview(effectiveFrom, effectiveTo, venueId);
  }
}
