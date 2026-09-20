import { Approval, Booking, Venue } from './types';
import { fitsWindows, gapMinutes, overlaps } from './time';

/**
 * 冲突判断结果中的违规项。
 * severity:
 *  - HARD     硬冲突，直接拒绝（时段重叠、场地关闭、设备缺失、超出可用时段、时间非法）
 *  - WAIVABLE 需额外批准的例外（消防容量、特殊通行要求），获批后可确认
 */
export interface Violation {
  code:
    | 'INVALID_TIME'
    | 'VENUE_CLOSED'
    | 'OUTSIDE_AVAILABILITY'
    | 'CAPACITY_EXCEEDED'
    | 'ACCESSIBILITY_UNAVAILABLE'
    | 'EQUIPMENT_MISSING'
    | 'TIME_OVERLAP';
  severity: 'HARD' | 'WAIVABLE';
  /** WAIVABLE 时对应的批准类型 */
  approvalType?: 'FIRE_CAPACITY' | 'SPECIAL_ACCESS';
  message: string;
  details?: Record<string, unknown>;
}

export interface PlacementEvaluation {
  violations: Violation[];
  /** 与前/后相邻预约的间隔小于清场缓冲，需要责任交接 */
  tightNeighbors: Booking[];
}

export interface PlacementRequest {
  start: string;
  end: string;
  attendees: number;
  requiresAccessibleRoute: boolean;
  requiredEquipment: string[];
}

/**
 * 评估一次场地使用是否可行。纯函数，便于单测。
 * existing 为该场地当前占用中的预约（CONFIRMED / IN_PROGRESS），不含本预约。
 */
export function evaluatePlacement(
  venue: Venue,
  req: PlacementRequest,
  existing: Booking[],
): PlacementEvaluation {
  const violations: Violation[] = [];

  if (!(req.start < req.end)) {
    violations.push({
      code: 'INVALID_TIME',
      severity: 'HARD',
      message: '开始时间必须早于结束时间',
    });
    return { violations, tightNeighbors: [] };
  }

  if (venue.status !== 'OPEN') {
    violations.push({
      code: 'VENUE_CLOSED',
      severity: 'HARD',
      message: `场地「${venue.name}」当前处于封闭状态`,
    });
  }

  if (!fitsWindows(req.start, req.end, venue.windows)) {
    violations.push({
      code: 'OUTSIDE_AVAILABILITY',
      severity: 'HARD',
      message: `预约时段超出场地「${venue.name}」的可用时段`,
      details: { windows: venue.windows },
    });
  }

  if (req.attendees > venue.capacity) {
    violations.push({
      code: 'CAPACITY_EXCEEDED',
      severity: 'WAIVABLE',
      approvalType: 'FIRE_CAPACITY',
      message: `人数 ${req.attendees} 超过场地「${venue.name}」安全容量 ${venue.capacity}，涉及消防容量，需额外批准`,
      details: { attendees: req.attendees, capacity: venue.capacity },
    });
  }

  if (req.requiresAccessibleRoute && !venue.accessible) {
    violations.push({
      code: 'ACCESSIBILITY_UNAVAILABLE',
      severity: 'WAIVABLE',
      approvalType: 'SPECIAL_ACCESS',
      message: `活动有无障碍通行需求，但场地「${venue.name}」的无障碍通道不可用，需特殊通行批准`,
    });
  }

  const missing = req.requiredEquipment.filter((e) => !venue.equipment.includes(e));
  if (missing.length > 0) {
    violations.push({
      code: 'EQUIPMENT_MISSING',
      severity: 'HARD',
      message: `场地「${venue.name}」缺少固定设备：${missing.join('、')}`,
      details: { missing },
    });
  }

  const tight: Booking[] = [];
  for (const other of existing) {
    if (overlaps(req.start, req.end, other.start, other.end)) {
      violations.push({
        code: 'TIME_OVERLAP',
        severity: 'HARD',
        message: `与预约「${other.title}」(${other.start} ~ ${other.end}) 时段重叠`,
        details: { conflictBookingId: other.id, conflictTitle: other.title },
      });
      continue;
    }
    // 清场时间纳入冲突判断：间隔小于清场缓冲时不算硬冲突，但必须完成责任交接
    const gap =
      other.end <= req.start
        ? gapMinutes(other.end, req.start)
        : gapMinutes(req.end, other.start);
    if (gap < venue.turnoverMinutes) {
      tight.push(other);
    }
  }

  return { violations, tightNeighbors: tight };
}

/** 判断可豁免违规是否都已被对应类型的已批准申请覆盖 */
export function uncoveredWaivables(violations: Violation[], approvals: Approval[]): Violation[] {
  const approvedTypes = new Set(
    approvals.filter((a) => a.status === 'APPROVED').map((a) => a.type),
  );
  return violations.filter(
    (v) => v.severity === 'WAIVABLE' && (!v.approvalType || !approvedTypes.has(v.approvalType)),
  );
}
