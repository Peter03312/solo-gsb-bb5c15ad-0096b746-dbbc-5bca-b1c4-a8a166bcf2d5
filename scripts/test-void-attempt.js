'use strict';

// 训练任务「尝试作废」端到端验证（临时库 + 真实 HTTP 服务，不写正式数据）：
//   node scripts/test-void-attempt.js
//
// 覆盖（本轮作废规则）：
//  A. 作废前置校验：缺学员凭证/管理凭证无效/学员凭证无效或跨任务 → 401/400，数据不变；
//     尝试不存在（序号越界/他人/跨任务）→ 404 TASK_ATTEMPT_NOT_FOUND，数据不变；
//     原因空/纯空白/超长 → 400 TASK_VOID_REASON_INVALID；进行中尝试 → 409 TASK_ATTEMPT_ACTIVE；
//  B. 首次作废已结束尝试：200 newlyVoided=true，返回作废记录与更新后的个人/汇总成绩；
//     只改有效性——会话仍 ended、路径/得分/冻结版本/历史尝试序号全部保留；
//  C. 有效占用/剩余次数：作废不占名额，attemptsLeft 按有效占用恢复；已用总次数（含作废）单列；
//     作废后可再开新尝试，新序号继续递增（不复用作废序号）；
//  D. 成绩口径：作废尝试不参与最高已结束分与及格判定；学员 /my 与管理视图含作废标记且同步；
//  E. 幂等与冲突：同次同原因重试 → 200 newlyVoided=false 原记录，不重复释放名额；
//     同次异原因重试 → 409 TASK_VOID_REASON_CONFLICT，数据不变；
//  F. 权限边界：普通入口查作废会话仍须本人凭证；作废后补做仍受原截止时间约束
//     （截止后不能开新尝试，仅可续做原有进行中尝试）；
//  G. 兼容：现有启动/接口字段不变（attemptsUsed 语义保留，新增 attemptsOccupied 等增量字段）。

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-void-http-'));
const dbPath = path.join(tmpDir, 'test.db');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`  ✅ ${name}`);
}
function eq(name, a, b) {
  assert.strictEqual(a, b, `${name}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
  passed++;
  console.log(`  ✅ ${name}`);
}

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, data };
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch (_) { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务启动超时');
}

// 把一次任务尝试从第 0 步沿“断电→撤离→上报→汇合”走到结局（满分 10）
async function playToEnd(taskId, token) {
  const start = await req('POST', `/api/tasks/${taskId}/start`, { token });
  assert.ok(start.status === 200 || start.status === 201, `开始尝试失败: ${start.status}`);
  const code = start.data.session.code;
  await req('POST', `/api/tasks/${taskId}/move`, { token, optionId: 'o_cut_power', stepNo: 0 });
  await req('POST', `/api/tasks/${taskId}/move`, { token, optionId: 'o_evac', stepNo: 1 });
  await req('POST', `/api/tasks/${taskId}/move`, { token, optionId: 'o_report', stepNo: 2 });
  const end = await req('POST', `/api/tasks/${taskId}/move`, { token, optionId: 'o_meet', stepNo: 3 });
  return { code, end };
}

(async () => {
  const child = spawn(process.execPath, ['server/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  try {
    await waitReady();
    console.log('0) 服务已启动（临时库）');

    const pub = await req('GET', '/api/published');
    const scenarioId = pub.data[0].id;
    const future = Date.now() + 3600 * 1000;
    const created = await req('POST', '/api/tasks', {
      scenarioId, version: 1, deadline: future, maxAttempts: 2, passScore: 5,
      trainees: ['张三', '李四'],
    });
    eq('建任务 201', created.status, 201);
    const taskId = created.data.taskId;
    const adminToken = created.data.adminToken;
    const tkA = created.data.trainees.find((t) => t.name === '张三').token;
    const tkB = created.data.trainees.find((t) => t.name === '李四').token;

    const other = await req('POST', '/api/tasks', {
      scenarioId, deadline: Date.now() + 3600e3, maxAttempts: 2, passScore: 5, trainees: ['王五'],
    });
    const tkOther = other.data.trainees[0].token;

    // 张三：第 1 次满分结束
    const a1 = await playToEnd(taskId, tkA);
    eq('张三第 1 次结束', a1.end.data.status, 'ended');
    eq('第 1 次总分 10', a1.end.data.totalScore, 10);
    const code1 = a1.code;
    // 张三：第 2 次坏结局 -10
    const s2 = await req('POST', `/api/tasks/${taskId}/start`, { token: tkA });
    eq('第 2 次序号为 2', s2.data.attemptNo, 2);
    const bad2 = await req('POST', `/api/tasks/${taskId}/move`, { token: tkA, optionId: 'o_rush_in', stepNo: 0 });
    eq('第 2 次结束 -10', bad2.data.totalScore, -10);
    const code2 = bad2.data.code;
    eq('两次用完：剩余 0', s2.data.attemptsLeft >= 0, true);

    const voidUrl = (n) => `/api/tasks/${taskId}/attempts/${n}/void`;

    // ---------- A. 作废前置校验 ----------
    console.log('A) 作废前置校验：非法凭证/序号/原因/进行中一律拒绝，不改变数据');
    const noTrainee = await req('POST', voidUrl(1), { adminToken, reason: '监考异常' });
    eq('缺学员凭证 400', noTrainee.status, 400);
    const badAdmin = await req('POST', voidUrl(1), { adminToken: 'adm_nope', token: tkA, reason: '监考异常' });
    eq('管理凭证无效 401', badAdmin.status, 401);
    eq('TASK_ADMIN_TOKEN_INVALID', badAdmin.data.errorCode, 'TASK_ADMIN_TOKEN_INVALID');
    const badToken = await req('POST', voidUrl(1), { adminToken, token: 'ptk_nope', reason: '监考异常' });
    eq('学员凭证无效 401', badToken.status, 401);
    eq('TASK_TOKEN_INVALID', badToken.data.errorCode, 'TASK_TOKEN_INVALID');
    const crossToken = await req('POST', voidUrl(1), { adminToken, token: tkOther, reason: '监考异常' });
    eq('跨任务学员凭证（王五对张三任务）401', crossToken.status, 401);

    const noReason = await req('POST', voidUrl(1), { adminToken, token: tkA, reason: '' });
    eq('空原因 400', noReason.status, 400);
    eq('TASK_VOID_REASON_INVALID', noReason.data.errorCode, 'TASK_VOID_REASON_INVALID');
    const blankReason = await req('POST', voidUrl(1), { adminToken, token: tkA, reason: '   ' });
    eq('纯空白原因 400', blankReason.status, 400);
    const longReason = await req('POST', voidUrl(1), { adminToken, token: tkA, reason: 'x'.repeat(501) });
    eq('超长原因 400', longReason.status, 400);

    const noNum = await req('POST', `/api/tasks/${taskId}/attempts/0/void`, { adminToken, token: tkA, reason: '监考异常' });
    eq('序号 0 → 404', noNum.status, 404);
    const missing = await req('POST', voidUrl(9), { adminToken, token: tkA, reason: '监考异常' });
    eq('不存在的尝试序号 404', missing.status, 404);
    eq('TASK_ATTEMPT_NOT_FOUND', missing.data.errorCode, 'TASK_ATTEMPT_NOT_FOUND');
    // 李四（尚无尝试）的第 1 次：不存在
    const otherAttempt = await req('POST', voidUrl(1), { adminToken, token: tkB, reason: '监考异常' });
    eq('李四不存在第 1 次 404', otherAttempt.status, 404);

    // 李四开始第 1 次但不结束 → 进行中不得作废
    const bStart = await req('POST', `/api/tasks/${taskId}/start`, { token: tkB });
    const activeVoid = await req('POST', voidUrl(bStart.data.attemptNo), { adminToken, token: tkB, reason: '监考异常' });
    eq('进行中尝试作废 409', activeVoid.status, 409);
    eq('TASK_ATTEMPT_ACTIVE', activeVoid.data.errorCode, 'TASK_ATTEMPT_ACTIVE');

    // 全部失败后管理视图无作废、无名额变化
    const mg0 = await req('GET', `/api/tasks/${taskId}/manage?token=${adminToken}`);
    const za0 = mg0.data.trainees.find((t) => t.name === '张三');
    eq('失败调用不改变：张三仍占用 2 次', za0.attemptsOccupied, 2);
    eq('失败调用不改变：已作废 0 次', za0.voidedCount, 0);

    // ---------- B. 首次作废 + 只改有效性 ----------
    console.log('B) 首次作废已结束尝试：只改有效性，路径/得分/版本/序号保留');
    const reason = '监考异常：第 2 次尝试期间场外提示';
    const v = await req('POST', voidUrl(2), { adminToken, token: tkA, reason });
    eq('作废成功 200', v.status, 200);
    eq('newlyVoided=true', v.data.newlyVoided, true);
    eq('作废记录：尝试序号', v.data.voided.attemptNo, 2);
    eq('作废记录：会话码为第 2 次', v.data.voided.sessionCode, code2);
    eq('作废记录：原因回显', v.data.voided.reason, reason);
    ok('作废记录含作废时间', !!v.data.voided.voidedAt);
    eq('作废记录：原得分保留（-10）', v.data.voided.totalScore, -10);

    // 会话仍为 ended，路径/得分/冻结版本保留，快照带作废标记
    const sess = await req('GET', `/api/sessions/${code2}?token=${tkA}`);
    eq('作废后会话仍 ended', sess.data.status, 'ended');
    eq('作废后快照 voided=true', sess.data.voided, true);
    eq('作废后快照原因', sess.data.voidReason, reason);
    ok('作废后快照含作废时间', !!sess.data.voidedAt);
    eq('作废后路径得分仍 -10', sess.data.totalScore, -10);
    eq('作废后冻结版本仍 v1', sess.data.version, 1);
    eq('作废后路径步数保留', sess.data.path.length, 1);
    eq('作废后尝试序号保留为 2', sess.data.attemptNo, 2);
    // 作废会话普通入口仍须本人凭证
    const sessNoTok = await req('GET', `/api/sessions/${code2}`);
    eq('作废会话无凭证仍 401', sessNoTok.status, 401);

    // ---------- C. 有效占用 / 名额释放 / 序号递增不复用 ----------
    console.log('C) 作废释放名额：已用总次数与有效占用区分，新序号递增不复用');
    const za1 = v.data.trainee;
    eq('已用总次数仍 2（含作废，序号保留）', za1.attemptsUsed, 2);
    eq('有效占用变为 1', za1.attemptsOccupied, 1);
    eq('已作废 1 次', za1.voidedCount, 1);
    eq('剩余次数按有效占用恢复为 1', za1.attemptsLeft, 1);
    eq('汇总：尝试总次数 3（张三2+李四1进行中）', v.data.summary.attemptsTotal, 3);
    eq('汇总：有效占用 2', v.data.summary.attemptsOccupied, 2);
    eq('汇总：已作废 1', v.data.summary.voidedCount, 1);

    // /my 同样区分两口径
    const mine1 = await req('GET', `/api/tasks/${taskId}/my?token=${tkA}`);
    eq('学员视图已用 2', mine1.data.attemptsUsed, 2);
    eq('学员视图有效占用 1', mine1.data.attemptsOccupied, 1);
    eq('学员视图剩余 1', mine1.data.attemptsLeft, 1);
    const rec2 = mine1.data.attempts.find((a) => a.attemptNo === 2);
    eq('学员视图第 2 次带作废标记', rec2.voided, true);
    eq('学员视图第 2 次原因', rec2.voidReason, reason);

    // 作废后可再开新尝试：序号为 3（不复用作废的 2）
    const s3 = await req('POST', `/api/tasks/${taskId}/start`, { token: tkA });
    eq('作废后开新尝试 201', s3.status, 201);
    eq('新尝试序号继续递增为 3（不复用 2）', s3.data.attemptNo, 3);
    eq('新尝试是新会话码', s3.data.session.code !== code2 && s3.data.session.code !== code1, true);
    eq('开始后已用总次数 3', s3.data.attemptsUsed, 3);
    eq('开始后有效占用 2', s3.data.attemptsOccupied, 2);
    eq('开始后剩余 0', s3.data.attemptsLeft, 0);
    const s3Dup = await req('POST', `/api/tasks/${taskId}/start`, { token: tkA });
    eq('第 3 次进行中重复开始返回原会话', s3Dup.data.resumed, true);
    eq('进行中不重复占用（仍 2）', s3Dup.data.attemptsOccupied, 2);
    // 有效占用已满：不能再开（第 4 次）
    // 先把第 3 次走到结束
    await req('POST', `/api/tasks/${taskId}/move`, { token: tkA, optionId: 'o_cut_power', stepNo: 0 });
    await req('POST', `/api/tasks/${taskId}/move`, { token: tkA, optionId: 'o_evac', stepNo: 1 });
    await req('POST', `/api/tasks/${taskId}/move`, { token: tkA, optionId: 'o_report', stepNo: 2 });
    const e3 = await req('POST', `/api/tasks/${taskId}/move`, { token: tkA, optionId: 'o_meet', stepNo: 3 });
    eq('第 3 次结束', e3.data.status, 'ended');
    const s4 = await req('POST', `/api/tasks/${taskId}/start`, { token: tkA });
    eq('有效占用已满（第 1、3 次有效），再开 409', s4.status, 409);
    eq('TASK_ATTEMPTS_EXHAUSTED', s4.data.errorCode, 'TASK_ATTEMPTS_EXHAUSTED');
    eq('错误响应带有效占用 2', s4.data.attemptsOccupied, 2);

    // ---------- D. 成绩口径：作废不参与最高已结束分 / 及格 ----------
    console.log('D) 成绩只算有效已结束尝试；个人与管理视图同步');
    const mg = await req('GET', `/api/tasks/${taskId}/manage?token=${adminToken}`);
    const za = mg.data.trainees.find((t) => t.name === '张三');
    // 有效已结束：第 1 次 10 分、第 3 次 10 分；第 2 次 -10 已作废，不参与
    eq('最高有效已结束分为 10（-10 已作废被剔除）', za.bestScore, 10);
    eq('张三已及格', za.passed, true);
    const mine2 = await req('GET', `/api/tasks/${taskId}/my?token=${tkA}`);
    eq('学员视图最高有效已结束分 10', mine2.data.bestScore, 10);
    eq('学员视图已及格', mine2.data.passed, true);

    // 把第 1 次（10 分）也作废 → 只剩第 3 次 10 分，成绩仍 10；再把第 3 次作废 → 无有效已结束，成绩为空
    const v1 = await req('POST', voidUrl(1), { adminToken, token: tkA, reason: '监考异常：首次尝试设备故障' });
    eq('作废第 1 次 200', v1.status, 200);
    eq('第 1 次作废后最高仍为 10（第 3 次）', v1.data.trainee.bestScore, 10);
    eq('第 1 次作废后有效占用 1（仅第 3 次）', v1.data.trainee.attemptsOccupied, 1);
    eq('第 1 次作废后剩余 1', v1.data.trainee.attemptsLeft, 1);
    eq('第 1 次作废后已用总次数仍 3', v1.data.trainee.attemptsUsed, 3);
    const v3 = await req('POST', voidUrl(3), { adminToken, token: tkA, reason: '监考异常：第 3 次替考' });
    eq('作废第 3 次 200', v3.status, 200);
    eq('全部有效结束尝试作废：bestScore=null', v3.data.trainee.bestScore, null);
    eq('全部作废：passed=null（成绩为空）', v3.data.trainee.passed, null);
    eq('全部作废：有效占用 0', v3.data.trainee.attemptsOccupied, 0);
    eq('全部作废：剩余恢复为 2', v3.data.trainee.attemptsLeft, 2);
    eq('已用总次数仍 3（序号不回收）', v3.data.trainee.attemptsUsed, 3);
    // 序号继续递增：再开为第 4 次
    const sAgain = await req('POST', `/api/tasks/${taskId}/start`, { token: tkA });
    eq('全部作废后再开：序号 4（不复用 1/2/3）', sAgain.data.attemptNo, 4);

    // ---------- E. 幂等与冲突 ----------
    console.log('E) 同次同原因幂等返回原记录；异原因报冲突且数据不变');
    const idem = await req('POST', voidUrl(2), { adminToken, token: tkA, reason });
    eq('同原因重试 200', idem.status, 200);
    eq('newlyVoided=false（幂等）', idem.data.newlyVoided, false);
    eq('幂等返回原作废时间', idem.data.voided.voidedAt, v.data.voided.voidedAt);
    eq('幂等返回原原因', idem.data.voided.reason, reason);
    eq('幂等不重复释放名额（有效占用口径不变）', idem.data.trainee.attemptsOccupied,
      v3.data.trainee.attemptsOccupied + 1); // 当前有第 4 次进行中：0+1

    const conflict = await req('POST', voidUrl(2), { adminToken, token: tkA, reason: '另一个不同原因' });
    eq('异原因重试 409', conflict.status, 409);
    eq('TASK_VOID_REASON_CONFLICT', conflict.data.errorCode, 'TASK_VOID_REASON_CONFLICT');
    eq('冲突响应回显原原因', conflict.data.existingReason, reason);
    // 冲突后原原因未被改写
    const mgAfter = await req('GET', `/api/tasks/${taskId}/manage?token=${adminToken}`);
    const recA2 = mgAfter.data.trainees.find((t) => t.name === '张三').attempts.find((a) => a.attemptNo === 2);
    eq('冲突后原作废原因保留', recA2.voidReason, reason);

    // ---------- F. 补做仍受原截止时间约束 ----------
    console.log('F) 作废/补做仍受原截止时间约束：截止后不能开新尝试，仅可续做进行中尝试');
    // 第 4 次进行中（张三）。直接把截止改到过去。
    const { open } = require('../server/db');
    const dbw = open(dbPath);
    dbw.prepare('UPDATE tasks SET deadline_ms = ? WHERE id = ?').run(Date.now() - 1000, taskId);
    dbw.close();
    // 截止后不能借“作废释放名额”开新尝试：李四当前第 1 次进行中，先把它结束再作废以释放名额
    const bEnd = await req('POST', `/api/tasks/${taskId}/move`, { token: tkB, optionId: 'o_rush_in', stepNo: 0 });
    eq('李四第 1 次可续做至结束（截止后仍允许）', bEnd.data.status, 'ended');
    const vB = await req('POST', voidUrl(1), { adminToken, token: tkB, reason: '监考异常（李四）' });
    eq('截止后仍可作废已结束尝试', vB.status, 200);
    const bNew = await req('POST', `/api/tasks/${taskId}/start`, { token: tkB });
    eq('截止后释放名额也不能开新尝试 409', bNew.status, 409);
    eq('TASK_DEADLINE_PASSED', bNew.data.errorCode, 'TASK_DEADLINE_PASSED');
    // 张三的第 4 次进行中：截止后仅可续做原有进行中尝试
    const resume4 = await req('POST', `/api/tasks/${taskId}/start`, { token: tkA });
    eq('截止后续做原有进行中尝试 200', resume4.status, 200);
    eq('仍是第 4 次原会话', resume4.data.session.attemptNo, 4);
    const move4 = await req('POST', `/api/tasks/${taskId}/move`, { token: tkA, optionId: 'o_cut_power', stepNo: 0 });
    eq('截止后进行中尝试可继续推进', move4.status, 200);

    // ---------- G. 兼容性：管理视图学员明细完整 ----------
    console.log('G) 管理视图同步更新，作废明细齐全；汇总口径一致');
    const mgFinal = await req('GET', `/api/tasks/${taskId}/manage?token=${adminToken}`);
    const zFinal = mgFinal.data.trainees.find((t) => t.name === '张三');
    eq('张三 4 条历史尝试全保留', zFinal.attempts.length, 4);
    eq('张三作废 3 次（1/2/3）', zFinal.voidedCount, 3);
    eq('张三有效占用 1（第 4 次进行中）', zFinal.attemptsOccupied, 1);
    eq('管理视图及格人数只算有效（张三无有效结束、李四无有效结束）', mgFinal.data.summary.passedCount, 0);

    console.log(`\n全部通过：${passed} 项断言。临时库：${dbPath}`);
    child.kill();
    process.exit(0);
  } catch (e) {
    console.error('❌ 测试失败：', e);
    child.kill();
    process.exit(1);
  }
})();
