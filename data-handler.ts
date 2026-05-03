import { prisma } from "./db";
import type { Employee, LeaveYear, LeaveRequest } from "@prisma/client";

// ─── 타입 ──────────────────────────────────────────────────────────────────

export type LeaveType = "FULL" | "HALF_AM" | "HALF_PM" | "TIME_1H" | "TIME_2H" | "TIME_3H" | "SUPPORT_2H";
export type RequestStatus = "PENDING" | "APPROVED" | "REJECTED";

export const LEAVE_TYPE_KO: Record<LeaveType, string> = {
  FULL: "종일",
  HALF_AM: "오전반차",
  HALF_PM: "오후반차",
  TIME_1H: "시간차(1h)",
  TIME_2H: "시간차(2h)",
  TIME_3H: "시간차(3h)",
  SUPPORT_2H: "지원대휴(2h)",
};

export const STATUS_KO: Record<RequestStatus, string> = {
  PENDING: "대기중",
  APPROVED: "승인",
  REJECTED: "반려",
};

const DAYS_BY_TYPE: Record<LeaveType, number> = {
  FULL: 1,
  HALF_AM: 0.5,
  HALF_PM: 0.5,
  TIME_1H: 0.125,
  TIME_2H: 0.25,
  TIME_3H: 0.375,
  SUPPORT_2H: 0.25,
};

export interface EmployeeWithYear {
  id: string;
  name: string;
  department: string;
  status: string;
  promotionStatus: string;
  joinedAt: string;
  resignedAt: string | null;
  year: number;
  totalDays: number;
  usedDays: number;
  remainingDays: number;
  carryOver: number;
  hasPassword: boolean;
  leaveNote: string | null;
  carryOverPolicy: string;
}

export interface PromotionView {
  id: string;
  employeeId: string;
  employeeName: string;
  year: number;
  round: number;
  snapshot: Record<string, unknown>;
  adminNote: string | null;
  sentAt: string;
  confirmedAt: string | null;
}

export interface RequestView {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  type: LeaveType;
  days: number;
  year: number;
  reason: string;
  status: RequestStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
}

// ─── 헬퍼 ──────────────────────────────────────────────────────────────────

function round1(n: number): number {
  return parseFloat(n.toFixed(1));
}

function currentYear(): number {
  return new Date().getFullYear();
}

function toEmployeeView(emp: Employee, ly: LeaveYear | null): EmployeeWithYear {
  const total = ly?.totalDays ?? 0;
  const used = ly?.usedDays ?? 0;
  return {
    id: emp.id,
    name: emp.name,
    department: emp.department,
    status: emp.status,
    promotionStatus: emp.promotionStatus,
    joinedAt: emp.joinedAt.toISOString(),
    resignedAt: emp.resignedAt?.toISOString() ?? null,
    year: ly?.year ?? currentYear(),
    totalDays: total,
    usedDays: round1(used),
    remainingDays: round1(Math.max(0, total - used)),
    carryOver: ly?.carryOver ?? 0,
    hasPassword: !!emp.password,
    leaveNote: ly?.note ?? null,
    carryOverPolicy: emp.carryOverPolicy,
  };
}

function toRequestView(req: LeaveRequest & { employee: { name: string } }): RequestView {
  return {
    id: req.id,
    employeeId: req.employeeId,
    employeeName: req.employee.name,
    date: req.date,
    type: req.type as LeaveType,
    days: req.days,
    year: req.year,
    reason: req.reason,
    status: req.status as RequestStatus,
    createdAt: req.createdAt.toISOString(),
    reviewedAt: req.reviewedAt?.toISOString() ?? null,
    reviewNote: req.reviewNote ?? null,
  };
}

// ─── 근로기준법 연차 계산 ─────────────────────────────────────────────────────

/**
 * 입사일 기준 법정 연차 일수 계산 (근로기준법 제60조)
 * - 1년 미만: 매월 개근 시 1일 (최대 11일) — 입사 후 경과 개월 수
 * - 1년 이상: 15일 + 매 2년마다 1일 가산 (최대 25일)
 */
export function calcLegalLeaveDays(joinedAt: Date, referenceDate: Date = new Date()): number {
  const joinDate = new Date(joinedAt);
  const ref = new Date(referenceDate);

  // 근속 연수 계산
  let years = ref.getFullYear() - joinDate.getFullYear();
  const anniv = new Date(joinDate);
  anniv.setFullYear(ref.getFullYear());
  if (ref < anniv) years--;

  if (years < 1) {
    // 1년 미만: 경과 개월 수 (최대 11일)
    let months = (ref.getFullYear() - joinDate.getFullYear()) * 12 + (ref.getMonth() - joinDate.getMonth());
    if (ref.getDate() < joinDate.getDate()) months--;
    return Math.min(Math.max(0, months), 11);
  }

  // 1년 이상: 15 + floor((years - 1) / 2), 최대 25
  const extra = Math.floor((years - 1) / 2);
  return Math.min(15 + extra, 25);
}

/**
 * 다음 연차 갱신일 계산 (입사 기념일 기준)
 * - 1년 미만: 다음 달 입사일
 * - 1년 이상: 다음 입사 기념일
 */
export function nextRenewalDate(joinedAt: Date, referenceDate: Date = new Date()): Date {
  const join = new Date(joinedAt);
  const ref = new Date(referenceDate);

  let years = ref.getFullYear() - join.getFullYear();
  const anniv = new Date(join);
  anniv.setFullYear(ref.getFullYear());
  if (ref < anniv) years--;

  if (years < 1) {
    // 다음 달 입사일
    const next = new Date(join);
    let months = (ref.getFullYear() - join.getFullYear()) * 12 + (ref.getMonth() - join.getMonth());
    if (ref.getDate() >= join.getDate()) months++;
    next.setMonth(join.getMonth() + months);
    return next;
  }

  // 다음 기념일
  const nextAnniv = new Date(join);
  nextAnniv.setFullYear(join.getFullYear() + years + 1);
  return nextAnniv;
}

/**
 * 전체 재직 직원 연차 자동 갱신 (입사기념일 기준)
 * 1) 올해 LeaveYear가 없으면 생성
 * 2) 입사기념일이 지났고 lastRenewedAt이 올해 갱신 전이면:
 *    - 이월 정책에 따라 잔여연차 처리
 *    - usedDays 초기화, 새 totalDays 부여
 *    - promotionStatus 초기화
 * 3) 법정 일수보다 낮으면 자동 증가
 */
export async function autoRenewLeave(): Promise<{ updated: number; skipped: number; details: string[] }> {
  const now = new Date();
  const y = now.getFullYear();
  const today = now.toISOString().slice(0, 10);

  const activeEmps = await prisma.employee.findMany({
    where: { status: "ACTIVE" },
    include: { leaveYears: { orderBy: { year: "desc" } } },
  });

  let updated = 0;
  let skipped = 0;
  const details: string[] = [];

  for (const emp of activeEmps) {
    const legalDays = calcLegalLeaveDays(emp.joinedAt, now);
    const thisYearLy = emp.leaveYears.find((l) => l.year === y);
    const lastYearLy = emp.leaveYears.find((l) => l.year === y - 1);

    // 올해 입사기념일
    const anniv = new Date(emp.joinedAt);
    anniv.setFullYear(y);
    const annivPassed = now >= anniv;

    // 갱신 필요 여부: 기념일 지남 + 올해 아직 갱신 안 됨
    const alreadyRenewed = emp.lastRenewedAt && emp.lastRenewedAt.getFullYear() === y
      && emp.lastRenewedAt >= anniv;
    const needsRenewal = annivPassed && !alreadyRenewed;

    if (needsRenewal && lastYearLy) {
      // 이월 정책 계산
      const remaining = round1(Math.max(0, lastYearLy.totalDays - lastYearLy.usedDays));
      let carryOver = 0;
      if (emp.carryOverPolicy === "CARRY_ALL") carryOver = remaining;
      else if (emp.carryOverPolicy === "CARRY_MAX5") carryOver = Math.min(remaining, 5);
      else if (emp.carryOverPolicy === "CARRY_MAX10") carryOver = Math.min(remaining, 10);
      // EXPIRE = 0

      const newTotal = round1(legalDays + carryOver);
      const note = `[${today}] ${y}년 입사기념일 갱신: 법정 ${legalDays}일` +
        (carryOver > 0 ? ` + 이월 ${carryOver}일` : ` (잔여 ${remaining}일 소멸)`) +
        ` = ${newTotal}일`;

      if (thisYearLy) {
        // 이미 올해 LeaveYear 있으면 리셋
        const prevNote = thisYearLy.note ? thisYearLy.note + "\n" : "";
        await prisma.leaveYear.update({
          where: { id: thisYearLy.id },
          data: { totalDays: newTotal, usedDays: 0, carryOver: round1(carryOver), note: prevNote + note },
        });
      } else {
        await prisma.leaveYear.create({
          data: { employeeId: emp.id, year: y, totalDays: newTotal, usedDays: 0, carryOver: round1(carryOver), note },
        });
      }

      // lastRenewedAt + promotionStatus 리셋
      await prisma.employee.update({
        where: { id: emp.id },
        data: { lastRenewedAt: now, totalDays: legalDays, promotionStatus: "NONE" },
      });

      details.push(`${emp.name}: 갱신 ${newTotal}일 (법정${legalDays}+이월${carryOver})`);
      updated++;
      continue;
    }

    // 갱신 불필요 — 올해 LeaveYear 없으면 생성만
    if (!thisYearLy) {
      const note = `[${today}] 연차 자동 생성: 법정 ${legalDays}일`;
      await prisma.leaveYear.create({
        data: { employeeId: emp.id, year: y, totalDays: legalDays, usedDays: 0, carryOver: 0, note },
      });
      details.push(`${emp.name}: 신규 생성 ${legalDays}일`);
      updated++;
      continue;
    }

    // 법정보다 낮으면 증가 (이월분 제외한 기본 일수 기준)
    const baseDays = round1(thisYearLy.totalDays - thisYearLy.carryOver);
    if (baseDays < legalDays) {
      const newTotal = round1(legalDays + thisYearLy.carryOver);
      const diff = round1(newTotal - thisYearLy.totalDays);
      const prevNote = thisYearLy.note ? thisYearLy.note + "\n" : "";
      await prisma.leaveYear.update({
        where: { id: thisYearLy.id },
        data: { totalDays: newTotal, note: prevNote + `[${today}] 법정 갱신 +${diff}일 → ${newTotal}일 (법정${legalDays}+이월${thisYearLy.carryOver})` },
      });
      details.push(`${emp.name}: +${diff} → ${newTotal}일`);
      updated++;
      continue;
    }

    skipped++;
  }

  return { updated, skipped, details };
}

/**
 * D-30 갱신 예정자 조회 (입사기념일 기준)
 */
export async function getRenewalCountdown(): Promise<Array<{
  id: string; name: string; department: string; joinedAt: string;
  anniversaryDate: string; dDay: number; legalDays: number; currentTotal: number;
  carryOverPolicy: string;
}>> {
  const now = new Date();
  const y = now.getFullYear();
  const todayMs = now.getTime();

  const emps = await prisma.employee.findMany({
    where: { status: "ACTIVE" },
    include: { leaveYears: { where: { year: y } } },
  });

  const results: Array<{
    id: string; name: string; department: string; joinedAt: string;
    anniversaryDate: string; dDay: number; legalDays: number; currentTotal: number;
    carryOverPolicy: string;
  }> = [];

  for (const emp of emps) {
    const anniv = new Date(emp.joinedAt);
    anniv.setFullYear(y);
    // 이미 지났으면 내년
    if (anniv.getTime() < todayMs) anniv.setFullYear(y + 1);

    const dDay = Math.ceil((anniv.getTime() - todayMs) / (1000 * 60 * 60 * 24));
    if (dDay > 30) continue;

    const legal = calcLegalLeaveDays(emp.joinedAt, anniv);
    const ly = emp.leaveYears[0];

    results.push({
      id: emp.id,
      name: emp.name,
      department: emp.department,
      joinedAt: emp.joinedAt.toISOString().slice(0, 10),
      anniversaryDate: anniv.toISOString().slice(0, 10),
      dDay,
      legalDays: legal,
      currentTotal: ly?.totalDays ?? 0,
      carryOverPolicy: emp.carryOverPolicy,
    });
  }

  return results.sort((a, b) => a.dDay - b.dDay);
}

/**
 * 직원별 이월 정책 변경
 */
export async function setCarryOverPolicy(
  employeeId: string,
  policy: string,
): Promise<void> {
  const valid = ["EXPIRE", "CARRY_ALL", "CARRY_MAX5", "CARRY_MAX10"];
  if (!valid.includes(policy)) throw new Error("유효하지 않은 이월 정책입니다.");
  await prisma.employee.update({
    where: { id: employeeId },
    data: { carryOverPolicy: policy as "EXPIRE" | "CARRY_ALL" | "CARRY_MAX5" | "CARRY_MAX10" },
  });
}

// ─── 직원 조회 ──────────────────────────────────────────────────────────────

export async function getEmployees(
  year?: number,
  includeResigned = false,
): Promise<EmployeeWithYear[]> {
  const y = year ?? currentYear();
  const where = includeResigned ? {} : { status: "ACTIVE" as const };

  const emps = await prisma.employee.findMany({
    where,
    include: { leaveYears: { where: { year: y } } },
    orderBy: { name: "asc" },
  });

  return emps.map((e) => toEmployeeView(e, e.leaveYears[0] ?? null));
}

// ─── 직원 추가 ──────────────────────────────────────────────────────────────

export async function addEmployee(
  name: string,
  totalDays: number,
  department: string,
  joinedAt: string,
): Promise<EmployeeWithYear[]> {
  if (!name.trim()) throw new Error("이름을 입력해주세요.");
  if (totalDays <= 0) throw new Error("총 연차는 0보다 커야 합니다.");

  const y = currentYear();
  await prisma.employee.create({
    data: {
      name: name.trim(),
      department: department.trim(),
      joinedAt: new Date(joinedAt),
      totalDays,
      leaveYears: {
        create: { year: y, totalDays, usedDays: 0, carryOver: 0 },
      },
    },
  });

  return getEmployees(y);
}

// ─── 총 연차 수정 ──────────────────────────────────────────────────────────

export async function updateEmployeeTotal(
  employeeId: string,
  totalDays: number,
  year?: number,
): Promise<EmployeeWithYear[]> {
  const y = year ?? currentYear();

  const ly = await prisma.leaveYear.findUnique({
    where: { employeeId_year: { employeeId, year: y } },
  });
  if (!ly) throw new Error(`${y}년 연차 기간이 없습니다. 먼저 연차 기간을 시작해주세요.`);
  if (totalDays < ly.usedDays) {
    throw new Error(`이미 승인된 연차(${ly.usedDays}일)보다 작게 설정할 수 없습니다.`);
  }

  await prisma.leaveYear.update({
    where: { id: ly.id },
    data: { totalDays },
  });

  return getEmployees(y);
}

// ─── 퇴사 처리 ──────────────────────────────────────────────────────────────

export async function resignEmployee(
  employeeId: string,
): Promise<EmployeeWithYear[]> {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) throw new Error("직원을 찾을 수 없습니다.");
  if (emp.status === "RESIGNED") throw new Error("이미 퇴사 처리된 직원입니다.");

  // 대기중 신청 자동 반려
  await prisma.leaveRequest.updateMany({
    where: { employeeId, status: "PENDING" },
    data: { status: "REJECTED", reviewNote: "퇴사 처리로 자동 반려", reviewedAt: new Date() },
  });

  await prisma.employee.update({
    where: { id: employeeId },
    data: { status: "RESIGNED", resignedAt: new Date() },
  });

  return getEmployees(currentYear(), true);
}

// ─── 퇴사 취소 (복직) ───────────────────────────────────────────────────────

export async function reinstateEmployee(
  employeeId: string,
): Promise<EmployeeWithYear[]> {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) throw new Error("직원을 찾을 수 없습니다.");
  if (emp.status === "ACTIVE") throw new Error("재직 중인 직원입니다.");

  await prisma.employee.update({
    where: { id: employeeId },
    data: { status: "ACTIVE", resignedAt: null },
  });

  return getEmployees(currentYear(), true);
}

// ─── 퇴사자 삭제 ────────────────────────────────────────────────────────────

export async function deleteEmployee(
  employeeId: string,
): Promise<EmployeeWithYear[]> {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) throw new Error("직원을 찾을 수 없습니다.");

  // 관련 데이터 모두 삭제 (순서 중요: FK 제약)
  await prisma.leaveRequest.deleteMany({ where: { employeeId } });
  await prisma.leavePromotion.deleteMany({ where: { employeeId } });
  await prisma.leaveYear.deleteMany({ where: { employeeId } });
  await prisma.employee.delete({ where: { id: employeeId } });

  return getEmployees(currentYear(), true);
}

// ─── 직원 비밀번호 ──────────────────────────────────────────────────────────

export async function setEmployeeMemo(
  employeeId: string,
  memo: string,
): Promise<void> {
  await prisma.employee.update({
    where: { id: employeeId },
    data: { memo: memo || null },
  });
}

export async function getEmployeeMemo(
  employeeId: string,
): Promise<string | null> {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { memo: true } });
  return emp?.memo ?? null;
}

export async function setEmployeePassword(
  employeeId: string,
  password: string,
): Promise<void> {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) throw new Error("직원을 찾을 수 없습니다.");
  await prisma.employee.update({
    where: { id: employeeId },
    data: { password },
  });
}

export async function verifyEmployeePassword(
  employeeId: string,
  password: string,
): Promise<boolean> {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) return false;
  if (!emp.password) return false; // 비밀번호 미설정
  return emp.password === password;
}

// ─── 연차 기간 시작 ─────────────────────────────────────────────────────────

export async function startLeaveYear(
  year: number,
  carryOverOption: "none" | "all" | "partial" = "none",
  maxCarryOver = 0,
): Promise<{ created: number; skipped: number }> {
  const activeEmps = await prisma.employee.findMany({
    where: { status: "ACTIVE" },
    include: { leaveYears: { where: { year: year - 1 } } },
  });

  let created = 0;
  let skipped = 0;

  for (const emp of activeEmps) {
    const exists = await prisma.leaveYear.findUnique({
      where: { employeeId_year: { employeeId: emp.id, year } },
    });
    if (exists) {
      skipped++;
      continue;
    }

    const prevYear = emp.leaveYears[0];
    let carryOver = 0;
    if (prevYear && carryOverOption !== "none") {
      const remaining = Math.max(0, prevYear.totalDays - prevYear.usedDays);
      carryOver =
        carryOverOption === "all"
          ? remaining
          : Math.min(remaining, maxCarryOver);
    }

    await prisma.leaveYear.create({
      data: {
        employeeId: emp.id,
        year,
        totalDays: round1(emp.totalDays + carryOver),
        usedDays: 0,
        carryOver: round1(carryOver),
      },
    });
    created++;
  }

  return { created, skipped };
}

// ─── 재량연차 부여 ──────────────────────────────────────────────────────────

export async function grantExtraDays(
  employeeIds: string[] | "all",
  days: number,
  reason: string,
  year?: number,
): Promise<{ granted: number; skipped: number }> {
  const y = year ?? currentYear();
  const today = new Date().toISOString().slice(0, 10);
  const note = `[${today}] 재량연차 +${days}일: ${reason}`;

  let targets: string[];
  if (employeeIds === "all") {
    const emps = await prisma.employee.findMany({
      where: { status: "ACTIVE" },
      select: { id: true },
    });
    targets = emps.map((e) => e.id);
  } else {
    targets = employeeIds;
  }

  let granted = 0;
  let skipped = 0;

  for (const empId of targets) {
    const ly = await prisma.leaveYear.findUnique({
      where: { employeeId_year: { employeeId: empId, year: y } },
    });
    if (!ly) {
      skipped++;
      continue;
    }

    const prevNote = ly.note ? ly.note + "\n" : "";
    await prisma.leaveYear.update({
      where: { id: ly.id },
      data: {
        totalDays: round1(ly.totalDays + days),
        note: prevNote + note,
      },
    });
    granted++;
  }

  return { granted, skipped };
}

// ─── 연도 목록 ──────────────────────────────────────────────────────────────

export async function getAvailableYears(): Promise<number[]> {
  const rows = await prisma.leaveYear.groupBy({
    by: ["year"],
    orderBy: { year: "desc" },
  });
  const years = rows.map((r) => r.year);
  if (!years.length) years.push(currentYear());
  return years;
}

// ─── 연차 신청 ──────────────────────────────────────────────────────────────

export async function getRequests(
  filters: { employeeId?: string; status?: string; year?: number } = {},
): Promise<RequestView[]> {
  const where: Record<string, unknown> = {};
  if (filters.employeeId) where.employeeId = filters.employeeId;
  if (filters.status) where.status = filters.status;
  if (filters.year) where.year = filters.year;

  const reqs = await prisma.leaveRequest.findMany({
    where,
    include: { employee: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });

  return reqs.map(toRequestView);
}

export async function submitRequest(
  employeeId: string,
  fields: { date: string; type: LeaveType; reason: string },
): Promise<RequestView[]> {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) throw new Error("직원을 찾을 수 없습니다.");
  if (emp.status === "RESIGNED") throw new Error("퇴사한 직원은 연차를 신청할 수 없습니다.");

  // 같은 날짜 중복 체크 (반차는 AM+PM 동시 허용)
  const existingOnDate = await prisma.leaveRequest.findMany({
    where: {
      employeeId,
      date: fields.date,
      status: { in: ["PENDING", "APPROVED"] },
    },
  });
  if (existingOnDate.length) {
    const hasFullDay = existingOnDate.some((r) => r.type === "FULL");
    const hasAM = existingOnDate.some((r) => r.type === "HALF_AM");
    const hasPM = existingOnDate.some((r) => r.type === "HALF_PM");

    if (hasFullDay || fields.type === "FULL") {
      throw new Error(`${fields.date}에 이미 신청이 있습니다.`);
    }
    if (fields.type === "HALF_AM" && hasAM) {
      throw new Error(`${fields.date}에 이미 오전반차 신청이 있습니다.`);
    }
    if (fields.type === "HALF_PM" && hasPM) {
      throw new Error(`${fields.date}에 이미 오후반차 신청이 있습니다.`);
    }
  }

  const y = currentYear();
  const days = DAYS_BY_TYPE[fields.type];

  await prisma.leaveRequest.create({
    data: {
      employeeId,
      date: fields.date,
      type: fields.type,
      days,
      year: y,
      reason: fields.reason.trim(),
    },
  });

  return getRequests({ employeeId });
}

// ─── 승인 ──────────────────────────────────────────────────────────────────

export async function approveRequest(
  requestId: string,
  note?: string,
): Promise<{ employees: EmployeeWithYear[]; requests: RequestView[] }> {
  const req = await prisma.leaveRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new Error("신청 내역을 찾을 수 없습니다.");
  if (req.status !== "PENDING") {
    throw new Error(`승인할 수 없는 상태입니다. (현재: ${STATUS_KO[req.status as RequestStatus]})`);
  }

  const ly = await prisma.leaveYear.findUnique({
    where: { employeeId_year: { employeeId: req.employeeId, year: req.year } },
  });
  if (!ly) throw new Error("해당 연도의 연차 기간이 없습니다.");

  const remaining = round1(ly.totalDays - ly.usedDays);
  if (req.days > remaining) {
    throw new Error(`잔여 연차(${remaining}일)가 부족합니다. (신청: ${req.days}일)`);
  }

  await prisma.$transaction([
    prisma.leaveRequest.update({
      where: { id: requestId },
      data: { status: "APPROVED", reviewedAt: new Date(), reviewNote: note ?? null },
    }),
    prisma.leaveYear.update({
      where: { id: ly.id },
      data: { usedDays: round1(ly.usedDays + req.days) },
    }),
  ]);

  const y = req.year;
  return { employees: await getEmployees(y), requests: await getRequests({ year: y }) };
}

// ─── 반려 ──────────────────────────────────────────────────────────────────

export async function rejectRequest(
  requestId: string,
  note?: string,
): Promise<{ employees: EmployeeWithYear[]; requests: RequestView[] }> {
  const req = await prisma.leaveRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new Error("신청 내역을 찾을 수 없습니다.");
  if (req.status !== "PENDING") {
    throw new Error(`반려할 수 없는 상태입니다. (현재: ${STATUS_KO[req.status as RequestStatus]})`);
  }

  await prisma.leaveRequest.update({
    where: { id: requestId },
    data: { status: "REJECTED", reviewedAt: new Date(), reviewNote: note ?? null },
  });

  const y = req.year;
  return { employees: await getEmployees(y), requests: await getRequests({ year: y }) };
}

// ─── 승인 취소 ──────────────────────────────────────────────────────────────

export async function cancelApproved(
  requestId: string,
): Promise<{ employees: EmployeeWithYear[]; requests: RequestView[] }> {
  const req = await prisma.leaveRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new Error("신청 내역을 찾을 수 없습니다.");
  if (req.status !== "APPROVED") {
    throw new Error(`승인 취소할 수 없는 상태입니다. (현재: ${STATUS_KO[req.status as RequestStatus]})`);
  }

  const ly = await prisma.leaveYear.findUnique({
    where: { employeeId_year: { employeeId: req.employeeId, year: req.year } },
  });

  if (ly) {
    await prisma.$transaction([
      prisma.leaveRequest.update({
        where: { id: requestId },
        data: { status: "REJECTED", reviewedAt: new Date(), reviewNote: "관리자 승인 취소" },
      }),
      prisma.leaveYear.update({
        where: { id: ly.id },
        data: { usedDays: round1(Math.max(0, ly.usedDays - req.days)) },
      }),
    ]);
  } else {
    await prisma.leaveRequest.update({
      where: { id: requestId },
      data: { status: "REJECTED", reviewedAt: new Date(), reviewNote: "관리자 승인 취소" },
    });
  }

  const y = req.year;
  return { employees: await getEmployees(y), requests: await getRequests({ year: y }) };
}

// ─── 연차 촉진 ──────────────────────────────────────────────────────────────

export async function createPromotion(
  employeeId: string,
  year: number,
  round: number,
  adminNote?: string,
): Promise<PromotionView> {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) throw new Error("직원을 찾을 수 없습니다.");

  const ly = await prisma.leaveYear.findUnique({
    where: { employeeId_year: { employeeId, year } },
  });
  if (!ly) throw new Error(`${year}년 연차 기간이 없습니다.`);

  if (round === 1 && emp.promotionStatus !== "NONE") {
    throw new Error("이미 1차 촉진이 완료된 직원입니다.");
  }
  if (round === 2 && emp.promotionStatus !== "FIRST_DONE") {
    throw new Error("1차 촉진을 먼저 완료해야 합니다.");
  }

  const remaining = round1(ly.totalDays - ly.usedDays);
  const approvedReqs = await prisma.leaveRequest.findMany({
    where: { employeeId, year, status: "APPROVED" },
    orderBy: { date: "asc" },
  });

  const snapshot = {
    촉진일시: new Date().toISOString(),
    촉진차수: round === 1 ? "1차 촉진 (사용 촉구)" : "2차 촉진 (사용 시기 지정)",
    직원명: emp.name,
    부서: emp.department,
    입사일: emp.joinedAt.toISOString().slice(0, 10),
    연차기간: `${year}년`,
    총연차: ly.totalDays,
    사용연차: ly.usedDays,
    잔여연차: remaining,
    이월일수: ly.carryOver,
    사용내역: approvedReqs.map((r) => ({
      날짜: r.date,
      종류: LEAVE_TYPE_KO[r.type as LeaveType] ?? r.type,
      일수: r.days,
      사유: r.reason,
    })),
    관리자메모: adminNote || null,
  };

  const promo = await prisma.leavePromotion.create({
    data: {
      employeeId,
      year,
      round,
      snapshot: JSON.stringify(snapshot),
      adminNote: adminNote || null,
    },
  });

  await prisma.employee.update({
    where: { id: employeeId },
    data: { promotionStatus: round === 1 ? "FIRST_DONE" : "SECOND_DONE" },
  });

  return toPromotionView(promo, emp.name);
}

export async function getPromotions(
  employeeId: string,
  year?: number,
): Promise<PromotionView[]> {
  const where: Record<string, unknown> = { employeeId };
  if (year) where.year = year;

  const promos = await prisma.leavePromotion.findMany({
    where,
    include: { employee: { select: { name: true } } },
    orderBy: { sentAt: "desc" },
  });

  return promos.map((p) => toPromotionView(p, p.employee.name));
}

export async function confirmPromotion(
  promotionId: string,
): Promise<PromotionView> {
  const promo = await prisma.leavePromotion.findUnique({
    where: { id: promotionId },
    include: { employee: { select: { name: true } } },
  });
  if (!promo) throw new Error("촉진 기록을 찾을 수 없습니다.");
  if (promo.confirmedAt) throw new Error("이미 확인된 촉진입니다.");

  const updated = await prisma.leavePromotion.update({
    where: { id: promotionId },
    data: { confirmedAt: new Date() },
    include: { employee: { select: { name: true } } },
  });

  return toPromotionView(updated, updated.employee.name);
}

export async function resetPromotionStatus(
  employeeId: string,
): Promise<void> {
  await prisma.employee.update({
    where: { id: employeeId },
    data: { promotionStatus: "NONE" },
  });
}

function toPromotionView(
  p: { id: string; employeeId: string; year: number; round: number; snapshot: string; adminNote: string | null; sentAt: Date; confirmedAt: Date | null },
  empName: string,
): PromotionView {
  let snapshot: Record<string, unknown> = {};
  try { snapshot = JSON.parse(p.snapshot); } catch { /* ignore */ }
  return {
    id: p.id,
    employeeId: p.employeeId,
    employeeName: empName,
    year: p.year,
    round: p.round,
    snapshot,
    adminNote: p.adminNote,
    sentAt: p.sentAt.toISOString(),
    confirmedAt: p.confirmedAt?.toISOString() ?? null,
  };
}
