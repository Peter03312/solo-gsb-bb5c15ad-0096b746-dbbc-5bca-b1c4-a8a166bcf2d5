'use strict';

// 训练任务「尝试作废」端到端验证（临时库 + 真实 HTTP 服务，不写正式数据）：
//   node scripts/test-void.js
//
// 覆盖（本轮能力）：
//  1. 作废只改有效性：原会话路径/得分/冻结版本/历史尝试序号保留；会话快照附作废标记；
//  2. 仅有效（未作废）尝试占用次数并参与最高已结束分与及格判定；名额释放后可再开新尝试，
//     新尝试序号继续递增、不复用作废序号；剩余次数按有效占用计算，已用总次数仍含作废；
//  3. 同一尝试同原因重试幂等返回原记录（200），不重复释放名额、不新增留痕；异原因 409 冲突
//     （TASK_VOID_REASON_CONFLICT，携带原记录，数据不变）；
//  4. 进行中尝试不得作废（409 TASK_ATTEMPT_ACTIVE）；
//  5. 非法管理凭证/参与凭证（含跨任务）/不存在尝试序号/空原因/非整数序号一律拒绝且不改数据；
//  6. 学员仅凭本人凭证在 /my 看到含作废标记的记录；培训师管理视图同步更新（汇总+逐人）；
//  7. 作废不改变截止时间：截止后不能开新尝试，仅可续做原有进行中尝试；
//  8. 既有接口与字段兼容：start/my/move/manage 旧字段保持；普通演练不受影响。

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
function ok(name, cond) { assert.ok(cond, name); passed++; console.log(`  ✅ ${name}`); }
function eq(name, a, b) {
  assert.strictEqual(a, b, `${name}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
  passed++; console.log(`  ✅ ${name}`);
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
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (_) { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务启动超时');
}

// 沿内置示例的“好结局”路径走到结束：断电→撤离→上报→汇合（总分 10）
async function playGood(taskId, token) {
  const s = await req('POST', `/api/tasks/${taskId}/start`, { token });
  const code = s.data.session.code;
  for (const [opt, step] of [['o_cut_power', 0], ['o_evac', 1], ['o_report', 2], ['o_meet', 3]]) {
    const r = await req('POST', `/api/tasks/${taskId}/move`, { token, optionId: opt, stepNo: step });
    if (r.status !== 200) throw new Error(`好结局推进失败 step=${step}: ${r.status} ${JSON.stringify(r.data)}`);
  }
  return code;
}
// “坏结局”：第 0 步擅闯（-10，直接结束，1 步）
async function playBad(taskId, token) {
  const s = await req('POST', `/api/tasks/${taskId}/start`, { token });
  const r = await req('POST', `/api/tasks/${taskId}/move`, { token, optionId: 'o_rush_in', stepNo: 0 });
  if (r.status !== 200) throw new Error(`坏结局推进失败: ${r.status}`);
  return s.data.session.code;
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

    // 任务：每人 3 次，及格 5
    const c = await req('POST', '/api/tasks', {
      scenarioId, version: 1, deadline: Date.now() + 3600e3,
      maxAttempts: 3, passScore: 5, trainees: ['张三', '李四'],
    });
    eq('建任务 201', c.status, 201);
    const taskId = c.data.taskId;
    const adminToken = c.data.adminToken;
    const tkA = c.data.trainees.find((t) => t.name === '张三').token;
    const tkB = c.data.trainees.find((t) => t.name === '李四').token;

    // 第 1 次：好结局 10；第 2 次：坏结局 -10
    const code1 = await playGood(taskId, tkA);
    const code2 = await playBad(taskId, tkA);

    console.log('1) 作废前基线：成绩取最高已结束分 10，占用 2/3');
    let mg = await req('GET', `/api/tasks/${taskId}/manage?token=${adminToken}`);
    let za = mg.data.trainees.find((t) => t.name === '张三');
    eq('已用 2 次', za.attemptsUsed, 2);
    eq('有效占用 2', za.validAttemptsUsed, 2);
    eq('剩余 1', za.attemptsLeft, 1);
    eq('最高已结束 10', za.bestScore, 10);
    eq('已及格', za.passed, true);
    eq('记录均未作废', za.attempts.every((a) => a.voided === false), true);

    console.log('2) 非法请求一律拒绝且不改数据');
    const v = (body) => req('POST', `/api/tasks/${taskId}/void`, body);
    let r = await v({ adminToken: 'adm_nope', token: tkA, attemptNo: 1, reason: '监考掉线' });
    eq('错误管理凭证 401', r.status, 401);
    eq('TASK_ADMIN_TOKEN_INVALID', r.data.errorCode, 'TASK_ADMIN_TOKEN_INVALID');
    r = await v({ adminToken, token: 'ptk_nope', attemptNo: 1, reason: '监考掉线' });
    eq('错误参与凭证 401', r.status, 401);
    eq('TASK_TOKEN_INVALID', r.data.errorCode, 'TASK_TOKEN_INVALID');
    // 跨任务：李四的凭证不能作废张三的尝试
    r = await v({ adminToken, token: tkB, attemptNo: 1, reason: '监考掉线' });
    eq('跨学员（凭证不属于该序号人）按不存在处理 404', r.status, 404);
    eq('TASK_ATTEMPT_NOT_FOUND', r.data.errorCode, 'TASK_ATTEMPT_NOT_FOUND');
    r = await v({ adminToken, token: tkA, attemptNo: 1, reason: '   ' });
    eq('空白原因 400', r.status, 400);
    eq('TASK_VOID_REASON_REQUIRED', r.data.errorCode, 'TASK_VOID_REASON_REQUIRED');
    r = await v({ adminToken, token: tkA, attemptNo: 1, reason: 42 });
    eq('非文本原因 400', r.status, 400);
    r = await v({ adminToken, token: tkA, attemptNo: 0, reason: 'x' });
    eq('序号 0 非法 400', r.status, 400);
    eq('TASK_ATTEMPT_NO_INVALID', r.data.errorCode, 'TASK_ATTEMPT_NO_INVALID');
    r = await v({ adminToken, token: tkA, attemptNo: 1.5, reason: 'x' });
    eq('序号非整数 400', r.status, 400);
    r = await v({ adminToken, token: tkA, attemptNo: 99, reason: 'x' });
    eq('不存在序号 404', r.status, 404);
    eq('TASK_ATTEMPT_NOT_FOUND', r.data.errorCode, 'TASK_ATTEMPT_NOT_FOUND');
    // 不存在的任务编号
    r = await req('POST', '/api/tasks/deadbeef00/void', { adminToken, token: tkA, attemptNo: 1, reason: 'x' });
    eq('任务不存在 404', r.status, 404);
    // 被拒绝后数据未变
    mg = await req('GET', `/api/tasks/${taskId}/manage?token=${adminToken}`);
    za = mg.data.trainees.find((t) => t.name === '张三');
    eq('拒绝后成绩仍 10/及格', za.bestScore === 10 && za.passed === true, true);
    eq('拒绝后仍占用 2', za.validAttemptsUsed, 2);

    console.log('3) 进行中尝试不得作废');
    const s3 = await req('POST', `/api/tasks/${taskId}/start`, { token: tkA });
    eq('开始第 3 次（进行中）', s3.data.attemptNo, 3);
    r = await v({ adminToken, token: tkA, attemptNo: 3, reason: '监考掉线' });
    eq('作废进行中 409', r.status, 409);
    eq('TASK_ATTEMPT_ACTIVE', r.data.errorCode, 'TASK_ATTEMPT_ACTIVE');
    // 把第 3 次走到坏结局结束（-10）
    await req('POST', `/api/tasks/${taskId}/move`, { token: tkA, optionId: 'o_rush_in', stepNo: 0 });
    const mine0 = await req('GET', `/api/tasks/${taskId}/my?token=${tkA}`);
    eq('3 次结束：已用 3 / 有效 3 / 剩余 0',
      `${mine0.data.attemptsUsed}/${mine0.data.validAttemptsUsed}/${mine0.data.attemptsLeft}`, '3/3/0');
    const again = await req('POST', `/api/tasks/${taskId}/start`, { token: tkA });
    eq('有效次数用完 409', again.status, 409);
    eq('TASK_ATTEMPTS_EXHAUSTED', again.data.errorCode, 'TASK_ATTEMPTS_EXHAUSTED');
    eq('耗尽响应区分两计数（已用3/有效3）', `${again.data.attemptsUsed}/${again.data.validAttemptsUsed}`, '3/3');

    console.log('4) 首次作废第 1 次（好结局 10 分）：201，只改有效性');
    r = await v({ adminToken, token: tkA, attemptNo: 1, reason: '监考画面中断，成绩无效' });
    eq('首次作废 201', r.status, 201);
    eq('idempotent=false', r.data.idempotent, false);
    eq('作废记录-任务', r.data.voidRecord.taskId, taskId);
    eq('作废记录-学员', r.data.voidRecord.traineeName, '张三');
    eq('作废记录-序号', r.data.voidRecord.attemptNo, 1);
    eq('作废记录-会话码保留', r.data.voidRecord.sessionCode, code1);
    eq('作废记录-原因', r.data.voidRecord.reason, '监考画面中断，成绩无效');
    ok('作废记录含作废时间', !!r.data.voidRecord.voidedAt);

    // 更新后的个人成绩（响应里直接带回）
    const tr = r.data.trainee;
    eq('个人：已用总次数仍 3', tr.attemptsUsed, 3);
    eq('个人：有效占用降为 2', tr.validAttemptsUsed, 2);
    eq('个人：作废数 1', tr.voidedCount, 1);
    eq('个人：剩余按有效占用 = 1', tr.attemptsLeft, 1);
    eq('个人：最高有效已结束分变为 -10', tr.bestScore, -10);
    eq('个人：不再及格', tr.passed, false);
    const a1 = tr.attempts.find((a) => a.attemptNo === 1);
    eq('第1次标记 voided', a1.voided, true);
    eq('第1次原得分保留 10', a1.totalScore, 10);
    eq('第1次原状态保留 ended', a1.status, 'ended');
    eq('第1次原因回显', a1.voidReason, '监考画面中断，成绩无效');
    ok('第1次作废时间回显', !!a1.voidedAt);
    const a2 = tr.attempts.find((a) => a.attemptNo === 2);
    eq('第2次仍有效', a2.voided, false);
    // 更新后的汇总成绩（响应里直接带回）
    eq('汇总：尝试总次数仍 3（含作废）', r.data.summary.attemptsTotal, 3);
    eq('汇总：有效占用总数 2', r.data.summary.validAttemptsTotal, 2);
    eq('汇总：作废数 1', r.data.summary.voidedCount, 1);
    eq('汇总：及格人数变 0', r.data.summary.passedCount, 0);

    // 原会话路径/冻结版本保留，且任务会话普通入口本人可查、快照附作废标记
    const snap = await req('GET', `/api/sessions/${code1}?token=${tkA}`);
    eq('原会话仍可查 200', snap.status, 200);
    eq('原会话路径 4 步保留', snap.data.path.length, 4);
    eq('原会话总分仍 10（仅有效性变）', snap.data.totalScore, 10);
    eq('原会话冻结版本 v1 保留', snap.data.version, 1);
    eq('原会话历史序号 1 保留', snap.data.attemptNo, 1);
    eq('快照 voided=true', snap.data.voided, true);
    eq('快照作废原因', snap.data.voidReason, '监考画面中断，成绩无效');
    ok('快照作废时间', !!snap.data.voidedAt);
    const snapNoTok = await req('GET', `/api/sessions/${code1}`);
    eq('他人/无凭证仍 401', snapNoTok.status, 401);

    console.log('5) 名额释放：可再开新尝试，序号继续递增不复用 1');
    const s4 = await req('POST', `/api/tasks/${taskId}/start`, { token: tkA });
    eq('释放后可开新尝试 201', s4.status, 201);
    eq('新尝试序号 = 4（不复用作废序号 1）', s4.data.attemptNo, 4);
    ok('新会话码不同于作废会话', s4.data.session.code !== code1);
    eq('已用总次数 4（含作废）', s4.data.attemptsUsed, 4);
    eq('有效占用 3', s4.data.validAttemptsUsed, 3);
    eq('剩余 0', s4.data.attemptsLeft, 0);
    // 第 4 次进行中——立即作废应被拒（进行中）
    r = await v({ adminToken, token: tkA, attemptNo: 4, reason: 'x' });
    eq('第4次进行中不得作废', r.data.errorCode, 'TASK_ATTEMPT_ACTIVE');
    // 结束第 4 次（坏结局 -10）
    await req('POST', `/api/tasks/${taskId}/move`, { token: tkA, optionId: 'o_rush_in', stepNo: 0 });

    console.log('6) 幂等：同原因重试返回原记录（200），不重复释放名额/不留第二条');
    const idem = await v({ adminToken, token: tkA, attemptNo: 1, reason: '  监考画面中断，成绩无效  ' });
    eq('同原因（允许首尾空白）200', idem.status, 200);
    eq('idempotent=true', idem.data.idempotent, true);
    eq('幂等返回原会话记录', idem.data.voidRecord.sessionCode, code1);
    eq('幂等返回原原因（trim 后比较）', idem.data.voidRecord.reason, '监考画面中断，成绩无效');
    eq('幂等后有效占用不变（3）', idem.data.trainee.validAttemptsUsed, 3);
    eq('幂等后作废数仍 1', idem.data.trainee.voidedCount, 1);
    const { open: openDb } = require('../server/db');
    const dbw = openDb(dbPath);
    const nVoid = dbw.prepare('SELECT COUNT(*) AS c FROM task_attempt_voids WHERE task_id = ?').get(taskId).c;
    eq('库中作废留痕仍只有 1 条', nVoid, 1);
    dbw.close();

    console.log('7) 异原因冲突：409 TASK_VOID_REASON_CONFLICT，携带原记录，数据不变');
    const conf = await v({ adminToken, token: tkA, attemptNo: 1, reason: '换一个原因' });
    eq('异原因 409', conf.status, 409);
    eq('TASK_VOID_REASON_CONFLICT', conf.data.errorCode, 'TASK_VOID_REASON_CONFLICT');
    ok('冲突响应携带原记录', !!conf.data.existingVoid && conf.data.existingVoid.reason === '监考画面中断，成绩无效');
    mg = await req('GET', `/api/tasks/${taskId}/manage?token=${adminToken}`);
    za = mg.data.trainees.find((t) => t.name === '张三');
    eq('冲突后原原因不变', za.attempts.find((a) => a.attemptNo === 1).voidReason, '监考画面中断，成绩无效');
    eq('冲突后有效占用不变（3）', za.validAttemptsUsed, 3);

    console.log('8) 学员本人视图含作废标记；他人凭证不可见');
    const mine = await req('GET', `/api/tasks/${taskId}/my?token=${tkA}`);
    eq('学员视图 200', mine.status, 200);
    const m1 = mine.data.attempts.find((a) => a.attemptNo === 1);
    eq('学员看到第1次 voided', m1.voided, true);
    eq('学员看到作废原因', m1.voidReason, '监考画面中断，成绩无效');
    eq('学员已用 4 / 有效 3 / 剩余 0',
      `${mine.data.attemptsUsed}/${mine.data.validAttemptsUsed}/${mine.data.attemptsLeft}`, '4/3/0');
    eq('学员最高有效分 -10', mine.data.attempts.filter((a) => a.status === 'ended' && !a.voided).map((a) => a.totalScore).sort()[0], -10);
    const mineB = await req('GET', `/api/tasks/${taskId}/my?token=ptk_nope`);
    eq('学员视图非法凭证 401', mineB.status, 401);

    console.log('9) 管理视图与作废响应一致（同步更新）');
    eq('管理视图已用 4', za.attemptsUsed, 4);
    eq('管理视图作废数 1', za.voidedCount, 1);
    eq('管理视图最高有效分 -10', za.bestScore, -10);
    eq('汇总作废总数 1', mg.data.summary.voidedCount, 1);
    eq('汇总有效占用总数', mg.data.summary.validAttemptsTotal, 3 + 0); // 张三 3、李四 0

    console.log('10) 作废不改变截止时间：截止后不能开新尝试，仅可续做原有进行中尝试');
    // (a) 李四留一条“进行中”尝试，再把任务截止时间改到过去：只能续做这条，不能另开
    const bStart = await req('POST', `/api/tasks/${taskId}/start`, { token: tkB });
    const bCode = bStart.data.session.code;
    const dbw2 = require('../server/db').open(dbPath);
    dbw2.prepare('UPDATE tasks SET deadline_ms = ? WHERE id = ?').run(Date.now() - 1000, taskId);
    dbw2.close();
    // 作废李四的进行中尝试：仍被拒（进行中不得作废）
    r = await v({ adminToken, token: tkB, attemptNo: bStart.data.attemptNo, reason: '监考异常' });
    eq('截止后进行中尝试仍不得作废', r.data.errorCode, 'TASK_ATTEMPT_ACTIVE');
    // 截止后调用 start：因有进行中尝试，返回原会话（续做，200），而不是另开新尝试
    const resume = await req('POST', `/api/tasks/${taskId}/start`, { token: tkB });
    eq('截止后续做原进行中尝试 200', resume.status, 200);
    eq('resumed=true', resume.data.resumed, true);
    eq('续做返回原会话', resume.data.session.code, bCode);
    const bEnd = await req('POST', `/api/tasks/${taskId}/move`, { token: tkB, optionId: 'o_cut_power', stepNo: 0 });
    eq('截止后仍可推进旧会话', bEnd.status, 200);

    // (b) 独立任务验证“无进行中尝试时，截止后开新尝试被拒”——即便作废释放了名额也不能补做
    const cDead = await req('POST', '/api/tasks', {
      scenarioId, deadline: Date.now() + 3600e3, maxAttempts: 3, passScore: 0, trainees: ['赵六'],
    });
    const adminD = cDead.data.adminToken;
    const tkD = cDead.data.trainees[0].token;
    const dCode = await playBad(cDead.data.taskId, tkD); // 第 1 次已结束（-10）
    // 截止前先把这次作废、释放名额
    r = await req('POST', `/api/tasks/${cDead.data.taskId}/void`,
      { adminToken: adminD, token: tkD, attemptNo: 1, reason: '监考异常' });
    eq('截止前作废成功（释放名额）', r.status, 201);
    eq('释放后有效占用 0 / 剩余 3', `${r.data.trainee.validAttemptsUsed}/${r.data.trainee.attemptsLeft}`, '0/3');
    // 该会话仍可查（作废不删会话）
    const dSnap = await req('GET', `/api/sessions/${dCode}?token=${tkD}`);
    eq('作废会话保留可查', dSnap.data.voided, true);
    // 现在把截止时间改到过去：虽有名额，也不能开新尝试（补做仍须满足原截止时间）
    const dbw3 = require('../server/db').open(dbPath);
    dbw3.prepare('UPDATE tasks SET deadline_ms = ? WHERE id = ?').run(Date.now() - 1000, cDead.data.taskId);
    dbw3.close();
    const late = await req('POST', `/api/tasks/${cDead.data.taskId}/start`, { token: tkD });
    eq('截止后即使有名额也不能开新尝试 409', late.status, 409);
    eq('TASK_DEADLINE_PASSED', late.data.errorCode, 'TASK_DEADLINE_PASSED');
    eq('截止后剩余名额仍按有效占用显示（3）', late.data.validAttemptsUsed, 0);

    console.log('11) 跨任务隔离：另一任务的学员凭证不能作废本任务尝试');
    const c2 = await req('POST', '/api/tasks', {
      scenarioId, deadline: Date.now() + 3600e3, maxAttempts: 1, passScore: 0, trainees: ['王五'],
    });
    const tkC = c2.data.trainees[0].token;
    r = await req('POST', `/api/tasks/${taskId}/void`, { adminToken, token: tkC, attemptNo: 1, reason: 'x' });
    eq('跨任务凭证 401（非法/跨任务凭证不泄露名单）', r.status, 401);
    eq('TASK_TOKEN_INVALID', r.data.errorCode, 'TASK_TOKEN_INVALID');
    r = await req('POST', `/api/tasks/${c2.data.taskId}/void`, { adminToken, token: tkC, attemptNo: 1, reason: 'x' });
    eq('本任务管理凭证不能管别的任务 401', r.status, 401);
    eq('TASK_ADMIN_TOKEN_INVALID', r.data.errorCode, 'TASK_ADMIN_TOKEN_INVALID');

    console.log('12) 兼容性：普通演练与既有任务字段不受影响');
    const ns = await req('POST', '/api/sessions', { scenarioId, traineeName: '普通学员' });
    eq('普通会话照常开始', ns.status, 201);
    eq('普通会话无作废标记', ns.data.voided, undefined);
    // 旧字段仍在
    const my2 = await req('GET', `/api/tasks/${taskId}/my?token=${tkA}`);
    ok('my 仍含 attemptsUsed/attemptsLeft 旧字段', 'attemptsUsed' in my2.data && 'attemptsLeft' in my2.data);
    ok('my 新增 validAttemptsUsed', 'validAttemptsUsed' in my2.data);

    console.log(`\n全部通过：${passed} 项断言。临时库：${dbPath}`);
    child.kill();
    process.exit(0);
  } catch (e) {
    console.error('❌ 测试失败：', e);
    child.kill();
    process.exit(1);
  }
})();
