import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class WeeklySlotDto {
  @IsInt()
  weekday!: number;

  @IsString()
  open!: string;

  @IsString()
  end!: string;
}

export class VenueVersionDto {
  @IsInt()
  @Min(1)
  fireCapacity!: number;

  @IsBoolean()
  wheelchairAccessible!: boolean;

  @IsOptional()
  @IsString()
  accessibilityNote?: string;

  @IsArray()
  @IsString({ each: true })
  fixedEquipment!: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklySlotDto)
  weeklyAvailability!: WeeklySlotDto[];

  @IsInt()
  @Min(0)
  clearingMinutes!: number;

  @IsOptional()
  @IsString()
  changeReason?: string;
}

export class CreateVenueDto extends VenueVersionDto {
  @IsString()
  name!: string;
}

export class CreateActivityDto {
  @IsString()
  title!: string;

  @IsInt()
  @Min(1)
  expectedAttendees!: number;

  @IsBoolean()
  requiresWheelchair!: boolean;

  @IsArray()
  @IsString({ each: true })
  requiredEquipment!: string[];

  @IsOptional()
  @IsString()
  specialAccessNote?: string | null;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  audienceGroups!: string[];
}

export class UpdateActivityDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedAttendees?: number;

  @IsOptional()
  @IsBoolean()
  requiresWheelchair?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  requiredEquipment?: string[];

  @IsOptional()
  @IsString()
  specialAccessNote?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audienceGroups?: string[];
}

export class RequestBookingDto {
  @IsString()
  activityId!: string;

  @IsString()
  venueId!: string;

  @IsISO8601()
  startAt!: string;

  @IsISO8601()
  endAt!: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class ApproveDto {
  @IsString()
  type!: 'fire_capacity' | 'special_access';

  @IsOptional()
  @IsString()
  note?: string;
}

export class CancelDto {
  @IsString()
  reason!: string;
}

export class CreateClosureDto {
  @IsString()
  venueId!: string;

  @IsISO8601()
  startAt!: string;

  @IsISO8601()
  endAt!: string;

  @IsString()
  reason!: string;
}

export class CreateUserDto {
  @IsString()
  id!: string;

  @IsString()
  name!: string;

  @IsString()
  role!: 'owner' | 'staff' | 'approver';
}
