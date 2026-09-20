import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthUser } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { CreateActivityDto, UpdateActivityDto } from '../common/dto';
import { ActivitiesService } from './activities.service';

@Controller('activities')
@UseGuards(AuthGuard)
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  /** 活动负责人登记自己的项目 */
  @Post()
  create(@Body() dto: CreateActivityDto, @CurrentUser() user: AuthUser) {
    const id = this.activities.create({ ...dto, ownerId: user.id });
    return { id, ownerId: user.id };
  }

  /** 仅本人项目可修改（服务层强制校验 owner） */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateActivityDto,
    @CurrentUser() user: AuthUser,
  ) {
    this.activities.update(id, user.id, dto);
    return { id, updated: true };
  }

  @Get('mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.activities.listByOwner(user.id);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() _user: AuthUser) {
    return this.activities.requireActivity(id);
  }
}
