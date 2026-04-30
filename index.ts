#!/usr/bin/env node
import { Command } from "commander";
import {
  loadStorage,
  addEmployee,
  updateEmployeeTotal,
  submitRequest,
  approveRequest,
  rejectRequest,
  getRemainingDays,
  LeaveType,
} from "./data-handler";

const program = new Command();

program
  .name("leave")
  .description("연차 관리 CLI")
  .version("2.0.0");

// ─── employees list ───────────────────────────────────────────────────────────
program
  .command("employees")
  .description("직원 목록 및 연차 현황")
  .action(() => {
    const { employees } = loadStorage();
    console.log();
    console.log(`  ${"이름".padEnd(12)}${"총 연차".padEnd(10)}${"사용".padEnd(10)}잔여`);
    console.log(`  ${"─".repeat(44)}`);
    for (const e of employees) {
      console.log(
        `  ${e.name.padEnd(12)}${String(e.totalDays).padEnd(10)}${String(e.usedDays).padEnd(10)}${getRemainingDays(e)}`
      );
    }
    console.log();
  });

// ─── add-employee ─────────────────────────────────────────────────────────────
program
  .command("add-employee")
  .description("직원 추가")
  .requiredOption("-n, --name <name>", "이름")
  .option("-t, --total <days>", "총 연차 일수", "15")
  .action((opts) => {
    const total = parseFloat(opts.total);
    const updated = addEmployee(loadStorage(), opts.name, total);
    const emp = updated.employees[updated.employees.length - 1];
    console.log(`\n  ✅  ${emp.name} 추가 완료 (총 연차: ${emp.totalDays}일)\n`);
  });

// ─── set-total ────────────────────────────────────────────────────────────────
program
  .command("set-total <employeeId> <days>")
  .description("직원 총 연차 변경")
  .action((employeeId, daysStr) => {
    try {
      const total = parseFloat(daysStr);
      const updated = updateEmployeeTotal(loadStorage(), employeeId, total);
      const emp = updated.employees.find((e) => e.id === employeeId)!;
      console.log(`\n  ✅  ${emp.name}의 총 연차: ${emp.totalDays}일 (잔여: ${getRemainingDays(emp)}일)\n`);
    } catch (e: unknown) {
      console.error(`  오류: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─── request ──────────────────────────────────────────────────────────────────
program
  .command("request <employeeId>")
  .description("연차 신청 (pending 상태로 저장)")
  .requiredOption("-d, --date <YYYY-MM-DD>", "날짜")
  .requiredOption("-r, --reason <text>", "사유")
  .option("-t, --type <type>", "full | half-am | half-pm", "full")
  .action((employeeId, opts) => {
    try {
      const updated = submitRequest(loadStorage(), employeeId, {
        date: opts.date,
        type: opts.type as LeaveType,
        reason: opts.reason,
      });
      const req = updated.requests[updated.requests.length - 1];
      console.log(`\n  📋  신청 완료 (대기중) — ID: ${req.id}`);
      console.log(`  날짜: ${req.date}  종류: ${req.type}  사유: ${req.reason}\n`);
    } catch (e: unknown) {
      console.error(`  오류: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─── approve ──────────────────────────────────────────────────────────────────
program
  .command("approve <requestId>")
  .description("연차 신청 승인 (usedDays 차감)")
  .option("-n, --note <text>", "메모")
  .action((requestId, opts) => {
    try {
      approveRequest(loadStorage(), requestId, opts.note);
      console.log(`\n  ✅  승인 완료 — ID: ${requestId}\n`);
    } catch (e: unknown) {
      console.error(`  오류: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─── reject ───────────────────────────────────────────────────────────────────
program
  .command("reject <requestId>")
  .description("연차 신청 반려")
  .option("-n, --note <text>", "반려 사유")
  .action((requestId, opts) => {
    try {
      rejectRequest(loadStorage(), requestId, opts.note);
      console.log(`\n  ❌  반려 완료 — ID: ${requestId}\n`);
    } catch (e: unknown) {
      console.error(`  오류: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─── requests ─────────────────────────────────────────────────────────────────
program
  .command("requests")
  .description("신청 내역 목록")
  .option("-s, --status <status>", "pending | approved | rejected")
  .action((opts) => {
    let { requests } = loadStorage();
    if (opts.status) requests = requests.filter((r) => r.status === opts.status);
    requests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    console.log();
    console.log(`  ${"직원".padEnd(10)}${"날짜".padEnd(12)}${"상태".padEnd(10)}${"사유".padEnd(20)}ID`);
    console.log(`  ${"─".repeat(62)}`);
    for (const r of requests) {
      console.log(
        `  ${r.employeeName.padEnd(10)}${r.date.padEnd(12)}${r.status.padEnd(10)}${r.reason.slice(0, 18).padEnd(20)}${r.id}`
      );
    }
    console.log();
  });

program.parse(process.argv);
