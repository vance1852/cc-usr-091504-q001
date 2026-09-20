import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { AuthGuard, Roles } from '../common/auth';
import { DomainError } from '../common/errors';

@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Query('status') status?: string, @Query('bookingId') bookingId?: string) {
    if (status && !['PENDING', 'SENT'].includes(status)) {
      throw DomainError.badRequest('status 只能为 PENDING 或 SENT');
    }
    return this.notifications.list({ status, bookingId });
  }

  /** 总务派发全部（或指定）待发送通知 */
  @Post('dispatch')
  @Roles('staff')
  dispatch(@Body() body: any) {
    const ids = body?.ids;
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string'))) {
      throw DomainError.badRequest('ids 必须为字符串数组');
    }
    return { dispatched: this.notifications.dispatch(ids) };
  }
}
