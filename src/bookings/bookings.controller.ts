import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthUser } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { ApproveDto, CancelDto, RequestBookingDto } from '../common/dto';
import { BookingsService } from './bookings.service';

@Controller('bookings')
@UseGuards(AuthGuard)
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  /** 提交申请前的试评估：不产生任何占用，返回冲突依据 */
  @Post('evaluate')
  evaluate(@Body() dto: RequestBookingDto, @CurrentUser() _user: AuthUser) {
    const evaluation = this.bookings.evaluateVenue(
      dto.activityId,
      dto.venueId,
      dto.startAt,
      dto.endAt,
    );
    return {
      venueId: dto.venueId,
      venueName: evaluation.venueName,
      venueVersion: evaluation.version.version,
      venueVersionId: evaluation.versionId,
      conflictReport: evaluation.report,
    };
  }

  /** 时间窗内各场地的实际使用者/占位（静态路由须在 :id 之前注册） */
  @Get()
  list(
    @CurrentUser() _user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('venueId') venueId?: string,
  ) {
    if (!from || !to) {
      throw new BadRequestException('请提供 from 与 to 查询参数（ISO 时间）');
    }
    return {
      window: { from, to },
      usages: this.bookings.usageInWindow(from, to, venueId),
    };
  }

  @Get('handovers/list')
  listHandovers(
    @CurrentUser() _user: AuthUser,
    @Query('venueId') venueId?: string,
  ) {
    return this.bookings.listHandovers(venueId);
  }

  @Get('cleanup/list')
  listCleanup(
    @CurrentUser() _user: AuthUser,
    @Query('status') status?: string,
    @Query('venueId') venueId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.bookings.listCleanup({ status, venueId, from, to });
  }

  /** 提交场地申请（支持幂等键，重复请求不产生双重占用） */
  @Post()
  request(@Body() dto: RequestBookingDto, @CurrentUser() user: AuthUser) {
    return this.bookings.requestBooking(dto, user.id);
  }

  @Post('handovers/:id/confirm')
  confirmHandover(
    @Param('id') id: string,
    @Body() body: { side: 'predecessor' | 'successor' },
    @CurrentUser() user: AuthUser,
  ) {
    return this.bookings.confirmHandover(Number(id), body.side, user.id);
  }

  @Post('cleanup/:id/done')
  completeCleanup(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.bookings.completeCleanup(Number(id), user.id);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() _user: AuthUser) {
    return this.bookings.getBooking(id);
  }

  /** 负责人取消本人未开始/进行中的申请 */
  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.bookings.cancel(id, user.id, dto.reason);
  }

  /** 审批员授予消防容量/特殊通行例外 */
  @Post(':id/approvals')
  @Roles('approver')
  approve(
    @Param('id') id: string,
    @Body() dto: ApproveDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.bookings.approve(id, dto.type, user.id, dto.note ?? '');
  }
}
