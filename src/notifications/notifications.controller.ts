import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthUser } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** 总务人员触发待发通知的投递 */
  @Post('dispatch')
  @Roles('staff')
  dispatch(@CurrentUser() _user: AuthUser) {
    const sent = this.notifications.dispatchPending();
    return { sent, count: sent.length };
  }

  @Get('status')
  status(
    @CurrentUser() _user: AuthUser,
    @Query('venueId') venueId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!venueId) throw new BadRequestException('请提供 venueId 查询参数');
    return {
      venueId,
      summary: this.notifications.statusForVenue(venueId, from, to),
    };
  }
}
