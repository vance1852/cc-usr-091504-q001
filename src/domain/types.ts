/** 周内可用时段，weekday: 0=周日 … 6=周六，时间为本地 HH:MM */
export interface WeeklySlot {
  weekday: number;
  open: string;
  end: string;
}

/** 场地某一版本的全部属性（确认单永久快照此对象） */
export interface VenueVersionData {
  version: number;
  fireCapacity: number;
  wheelchairAccessible: boolean;
  accessibilityNote: string;
  fixedEquipment: string[];
  weeklyAvailability: WeeklySlot[];
  clearingMinutes: number;
  changeReason: string;
  createdAt: string;
}

/** 确认单永久保留的场地快照 */
export type VenueSnapshot = VenueVersionData & {
  venueId: string;
  venueName: string;
  versionId: number;
  capturedAt: string;
};

export type UserRole = 'owner' | 'staff' | 'approver';

export interface ActivitySpec {
  id?: string;
  title: string;
  ownerId: string;
  expectedAttendees: number;
  requiresWheelchair: boolean;
  requiredEquipment: string[];
  /** 特殊通行要求（如“担架通道”“家长车辆进入”），需额外批准 */
  specialAccessNote?: string | null;
  /** 受影响人群标签，如 学生/家长/保洁 */
  audienceGroups: string[];
}

export interface BookingRequest {
  activityId: string;
  venueId: string;
  startAt: string;
  endAt: string;
}

export type ConflictKind =
  | 'time_overlap'
  | 'outside_availability'
  | 'closure'
  | 'missing_equipment'
  | 'capacity_exceeded'
  | 'wheelchair_unavailable'
  | 'special_access_unapproved';

export interface ConflictReason {
  kind: ConflictKind;
  hard: boolean;
  message: string;
  detail?: Record<string, unknown>;
}

export interface ConflictReport {
  feasible: boolean;
  reasons: ConflictReason[];
  /** 可经批准豁免的冲突类型 */
  approvalsNeeded: Array<'fire_capacity' | 'special_access'>;
}

export interface BookingView {
  id: string;
  activityId: string;
  venueId: string;
  venueVersion: number;
  startAt: string;
  endAt: string;
  status: string;
  title: string;
  ownerId: string;
  audienceGroups: string[];
  conflictReport: ConflictReport | null;
}

export interface SlotUsage {
  time: string;
  /** 该时刻该场地的实际（已确认）使用者 */
  actualUsers: BookingView[];
  /** 已占用待交接的候选 */
  held: BookingView[];
}
