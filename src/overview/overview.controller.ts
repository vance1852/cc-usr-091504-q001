import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthUser } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { OverviewService } from './overview.service';

@Controller('overview')
@UseGuards(AuthGuard)
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  /** 时间窗态势：实际使用者/待清场/冲突依据/受影响人群/通知状态 */
  @Get('situation')
  situation(
    @CurrentUser() _user: AuthUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('venueId') venueId?: string,
  ) {
    return this.overview.situation(from, to, venueId);
  }
}
