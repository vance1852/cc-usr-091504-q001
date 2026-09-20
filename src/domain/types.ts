/**
 * 领域类型定义。
 *
 * 关键概念：
 * - Venue 场地：容量/无障碍/固定设备/可用时段/清场缓冲，任何变更都会使 version 自增，
 *   并在 venue_versions 中留下完整快照，作为后续确认的“依据版本”。
 * - Booking 活动预约：由负责人创建（PENDING），确认（CONFIRMED）时记录所依据的场地版本。
 * - Handover 交接：同一空间前后两场间隔小于清场缓冲时自动生成，需前后责任人分别确认。
 * - Closure 临时封闭：总务封闭场地时计算影响，给出替代方案或无法安置的明确原因。
 */

export type Role = 'organizer' | 'staff' | 'approver';

export interface AuthUser {
  id: string;
  role: Role;
}

export interface TimeWindow {
  /** 0=周日 … 6=周六（UTC） */
  dayOfWeek: number;
  /** 'HH:MM' */
  start: string;
  /** 'HH:MM' */
  end: string;
}

export type VenueStatus = 'OPEN' | 'CLOSED';

export interface Venue {
  id: string;
  name: string;
  /** 安全容量（消防上限） */
  capacity: number;
  /** 无障碍通道是否可用 */
  accessible: boolean;
  /** 固定设备清单 */
  equipment: string[];
  /** 可用时段（按星期循环） */
  windows: TimeWindow[];
  /** 清场缓冲（分钟）：前一场结束后需要留出的清场时间 */
  turnoverMinutes: number;
  status: VenueStatus;
  /** 场地版本：任何影响活动安排的属性变更都会自增 */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface VenueVersion {
  id: string;
  venueId: string;
  version: number;
  /** 该版本场地属性的完整快照 */
  snapshot: Omit<Venue, 'createdAt' | 'updatedAt'>;
  changeReason: string;
  changedBy: string;
  changedAt: string;
}

export type BookingStatus =
  | 'PENDING' // 已提交，待确认
  | 'CONFIRMED' // 已确认（占用场地）
  | 'IN_PROGRESS' // 已开始（不可静默迁移）
  | 'COMPLETED' // 已结束
  | 'CANCELLED' // 已取消
  | 'DISPLACED'; // 因场地封闭且无可满足硬条件的替代场地而无处安置

export const ACTIVE_BOOKING_STATUSES: BookingStatus[] = ['CONFIRMED', 'IN_PROGRESS'];

export interface Booking {
  id: string;
  ownerId: string;
  ownerName: string | null;
  title: string;
  attendees: number;
  requiresAccessibleRoute: boolean;
  requiredEquipment: string[];
  /** 受影响人群，如 students / parents / cleaning */
  audienceGroups: string[];
  start: string;
  end: string;
  venueId: string;
  /** 确认时所依据的场地版本 */
  venueVersion: number | null;
  status: BookingStatus;
  idempotencyKey: string | null;
  requestHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BookingEvent {
  id: string;
  bookingId: string;
  type: string;
  payload: Record<string, unknown>;
  actorId: string;
  createdAt: string;
}

export interface CleanupItem {
  key: string;
  label: string;
  done: boolean;
}

export type HandoverStatus = 'PENDING' | 'COMPLETE';

export interface Handover {
  id: string;
  venueId: string;
  outBookingId: string;
  inBookingId: string;
  cleanupItems: CleanupItem[];
  outConfirmedBy: string | null;
  outConfirmedAt: string | null;
  inConfirmedBy: string | null;
  inConfirmedAt: string | null;
  status: HandoverStatus;
  createdAt: string;
}

export type ApprovalType = 'FIRE_CAPACITY' | 'SPECIAL_ACCESS';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface Approval {
  id: string;
  bookingId: string;
  type: ApprovalType;
  status: ApprovalStatus;
  reason: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface Closure {
  id: string;
  venueId: string;
  reason: string;
  from: string;
  to: string;
  createdBy: string;
  createdAt: string;
}

export type ClosureImpactAction = 'RELOCATED' | 'UNABLE' | 'MANUAL_REQUIRED';

export interface ClosureImpact {
  id: string;
  closureId: string;
  bookingId: string;
  action: ClosureImpactAction;
  toVenueId: string | null;
  /** 无法安置时的明确原因；迁移时记录依据 */
  reasons: string[];
  createdAt: string;
}

export type NotificationStatus = 'PENDING' | 'SENT';

export interface Notification {
  id: string;
  bookingId: string;
  /** 目标人群：students / parents / cleaning / staff … */
  audienceGroup: string;
  message: string;
  status: NotificationStatus;
  createdAt: string;
  sentAt: string | null;
}
