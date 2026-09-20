import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthUser } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { CreateVenueDto, VenueVersionDto } from '../common/dto';
import { VenuesService } from './venues.service';

@Controller('venues')
@UseGuards(AuthGuard)
export class VenuesController {
  constructor(private readonly venues: VenuesService) {}

  /** 场地登记：仅总务人员 */
  @Post()
  @Roles('staff')
  create(@Body() dto: CreateVenueDto) {
    const { name, ...version } = dto;
    const id = this.venues.create(name, version);
    return { id, version: 1, name };
  }

  /**
   * 修改容量/无障碍/设备/可用时段/清场时间：仅总务人员，
   * 每次修改形成可追溯的场地新版本。
   */
  @Post(':id/versions')
  @Roles('staff')
  publishVersion(@Param('id') id: string, @Body() dto: VenueVersionDto) {
    const version = this.venues.publishNewVersion(id, dto);
    return { id, version };
  }

  @Post(':id/deactivate')
  @Roles('staff')
  deactivate(@Param('id') id: string) {
    this.venues.deactivate(id);
    return { id, active: false };
  }

  @Get()
  list(@CurrentUser() _user: AuthUser) {
    return this.venues.listAll();
  }

  @Get('active')
  listActive(@CurrentUser() _user: AuthUser) {
    return this.venues.listActive();
  }
}
