/**
 * TaskManager.js - FreeCore-Life 核心任务流引擎（推翻重构版）
 * ==========================================================
 * 核心设计原则：
 * 1. 单一移动控制器：彻底杜绝多控制器（physicTick/雷达/pathfinder）同时控制 bot 导致的高频抖动、瞬移回弹、网卡感。
 * 2. 真实物理与反作弊友好：寻路期间严禁破坏周围方块；只有进入采掘任务且站定后才允许精准采掘。
 * 3. 稳健射线挖掘：站定 -> 多面射线检测（确认真正暴露面，杜绝隔墙挖） -> 装备最佳工具 -> 视线对齐 -> 单次完整 bot.dig -> 走近拾取掉落物。
 * 4. 真实玩家世界导航：主城通过 /pa open zy_menu 菜单点击跨入资源区，再执行 /rtp 拓荒，不调用非法管理员指令。
 * 5. 聪明战斗：识别敌对生物并利用 1.9+ 武器攻速冷却攻击，低血量时后撤保命。
 */

const { goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalFollow, GoalXZ, GoalGetToBlock } = goals;
const Vec3 = require('vec3').Vec3;

// 智能寻路包装器（带温和脱困与超时控制）
function gotoSmart(bot, goal, timeoutMs = 12000, log = console.log) {
    return new Promise((resolve) => {
        if (!bot || !bot.entity || !bot.pathfinder) return resolve(false);

        let settled = false;
        let timer = null;
        let stuckChecker = null;
        let lastPos = bot.entity.position.clone();
        let stuckTicks = 0;

        const cleanup = (success, reason = '') => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (stuckChecker) clearInterval(stuckChecker);
            bot.clearControlStates();
            try { bot.pathfinder.setGoal(null); } catch (e) {}
            if (reason && reason !== 'goal_changed') {
                log(`[Navigation] 寻路结束: ${success ? '成功' : '失败'} (${reason})`);
            }
            resolve(success);
        };

        timer = setTimeout(() => {
            cleanup(false, `超时 (${timeoutMs}ms)`);
        }, timeoutMs);

        // 每秒温和检查一次是否卡墙
        stuckChecker = setInterval(() => {
            if (settled || !bot.entity) return;
            const p = bot.entity.position;

            // 水中防溺水上浮机制
            if (bot.entity.isInWater) {
                bot.setControlState('jump', true);
            }

            const dist = Math.hypot(p.x - lastPos.x, p.z - lastPos.z);
            if (dist < 0.15 && bot.pathfinder.isMoving()) {
                stuckTicks++;
                if (stuckTicks >= 3) {
                    // 连续 3 秒移动距离极短，温和后撤脱困
                    stuckTicks = 0;
                    log(`[Navigation] 疑似卡死蹭墙，执行微步后退绕障...`);
                    bot.clearControlStates();
                    bot.setControlState('back', true);
                    bot.setControlState('jump', true);
                    setTimeout(() => {
                        bot.setControlState('back', false);
                        bot.setControlState('jump', false);
                    }, 350);
                }
            } else {
                stuckTicks = 0;
            }
            lastPos = p.clone();
        }, 1000);

        bot.pathfinder.goto(goal)
            .then(() => cleanup(true, '达成目标'))
            .catch((err) => {
                const msg = String(err?.message || err || '');
                cleanup(false, msg.includes('goal was changed') ? 'goal_changed' : msg);
            });
    });
}

class TaskManager {
    constructor(bot, log, sendRedis) {
        this.bot = bot;
        this.log = log;
        this.sendRedis = sendRedis;

        this.planQueue = [];
        this.currentTask = null;
        this.isRunning = false;
        this.planGeneration = 0;
        this.activeMovementOwner = null;
        this.isDigging = false;
        this.lastEmergencyAt = 0;
        this.lastEmergencyTarget = '';
    }

    isBusy() {
        return this.isRunning || this.currentTask !== null || this.isDigging;
    }

    setPlan(tasks, append = false) {
        if (!Array.isArray(tasks)) return;
        if (!append) {
            this.planGeneration++;
            this.planQueue = [...tasks];
            if (this.currentTask) {
                this.log(`[TaskManager] 当前正在执行任务，已无缝置换后续任务队列 (gen=${this.planGeneration}, 待办=${this.planQueue.length})`);
                return;
            }
            this.log(`[TaskManager] 载入新任务计划 (gen=${this.planGeneration}, 共 ${tasks.length} 项)`);
            this.stopCurrentTask();
        } else {
            this.log(`[TaskManager] 追加 ${tasks.length} 项任务至队列`);
            this.planQueue.push(...tasks);
        }

        if (!this.isRunning && this.planQueue.length > 0) {
            this.runNextTask();
        }
    }

    interruptWith(taskSpec) {
        const now = Date.now();
        const target = String(taskSpec.target || 'hostile');
        if (now - this.lastEmergencyAt < 4000 && this.currentTask?.spec?.task === 'fight') return;
        if (now - this.lastEmergencyAt < 8000 && target === this.lastEmergencyTarget) return;

        this.lastEmergencyAt = now;
        this.lastEmergencyTarget = target;
        this.planGeneration++;
        this.stopCurrentTask();
        this.planQueue = this.planQueue.filter(t => t.task !== 'fight' && t.task !== 'kill');
        this.planQueue.unshift(taskSpec);
        if (!this.isRunning) this.runNextTask();
    }

    clearPlan() {
        this.log('[TaskManager] 收到清空指令，停下所有任务。');
        this.stopCurrentTask();
        this.planQueue = [];
        this.isRunning = false;
    }

    stopCurrentTask() {
        this.activeMovementOwner = null;
        this.isDigging = false;
        if (this.currentTask) {
            const task = this.currentTask;
            task.isAborted = true;
            if (typeof task.abort === 'function') task.abort();
            this.currentTask = null;
        }
        if (this.bot && this.bot.pathfinder) {
            try { this.bot.pathfinder.setGoal(null); } catch (e) {}
        }
        if (this.bot) {
            this.bot.clearControlStates();
        }
    }

    async runNextTask() {
        if (this.planQueue.length === 0) {
            this.isRunning = false;
            this.currentTask = null;
            this.log('✨ [TaskManager] 当前所有任务计划已圆满完成！');
            this.reportPlanStatus('PLAN_COMPLETED', '所有规划任务均已完成');
            return;
        }

        this.isRunning = true;
        const taskGeneration = this.planGeneration;
        const taskSpec = this.planQueue.shift();
        this.log(`▶ [TaskManager] 开始执行: [${taskSpec.task}] "${taskSpec.desc || ''}" (剩余待办: ${this.planQueue.length})`);

        let taskInstance = null;
        try {
            taskInstance = this.createTask(taskSpec);
            if (!taskInstance) {
                this.log(`[TaskManager] 未知任务类型: ${taskSpec.task}，跳过`);
                return this.runNextTask();
            }

            this.currentTask = taskInstance;
            const success = await taskInstance.execute();
            if (taskGeneration !== this.planGeneration) {
                this.log(`[TaskManager] 任务代次过期 (current=${this.planGeneration}, run=${taskGeneration})，放弃旧回调`);
                return;
            }

            if (success) {
                this.log(`✔ [TaskManager] 任务 [${taskSpec.task}] 顺利完成`);
            } else {
                this.log(`✖ [TaskManager] 任务 [${taskSpec.task}] 未达成目标，推进后续任务`);
            }
        } catch (err) {
            this.log(`[TaskManager] 任务异常: ${err.message}`);
        } finally {
            const stillCurrent = this.currentTask === taskInstance;
            if (stillCurrent) this.currentTask = null;
            if (stillCurrent) {
                setTimeout(() => {
                    if (this.isRunning && !this.currentTask) this.runNextTask();
                }, 300);
            }
        }
    }

    createTask(spec) {
        switch (spec.task) {
            case 'command':
                return new CommandTask(this.bot, spec, this.log);
            case 'collect':
                return new CollectTask(this.bot, spec, this.log, (fallback) => this.planQueue.unshift(fallback), this);
            case 'navigate':
                return new NavigateTask(this.bot, spec, this.log, this);
            case 'craft':
                return new CraftTask(this.bot, spec, this.log);
            case 'explore':
                return new ExploreTask(this.bot, spec, this.log, this);
            case 'follow':
                return new FollowTask(this.bot, spec, this.log, this);
            case 'fight':
            case 'kill':
                return new CombatTask(this.bot, spec, this.log, this);
            case 'leave_lobby':
                return new LeaveLobbyTask(this.bot, spec, this.log);
            default:
                return null;
        }
    }

    reportPlanStatus(status, details) {
        if (!this.sendRedis) return;
        const report = {
            type: 'plan_event',
            status,
            details,
            remainingCount: this.planQueue.length,
            timestamp: Date.now()
        };
        this.sendRedis('PUBLISH', 'freecore:agent:mc:life_event', JSON.stringify(report));
    }
}

// ----------------------------------------------------
// 1. CommandTask: 执行普通玩家游戏指令
// ----------------------------------------------------
class CommandTask {
    constructor(bot, spec, log) {
        this.bot = bot;
        this.spec = spec;
        this.log = log;
        this.isAborted = false;
        this.timer = null;
    }

    abort() {
        this.isAborted = true;
        if (this.timer) clearTimeout(this.timer);
    }

    execute() {
        return new Promise((resolve) => {
            if (this.isAborted) return resolve(false);
            const cmd = this.spec.cmd.startsWith('/') ? this.spec.cmd : '/' + this.spec.cmd;
            this.log(`[CommandTask] 玩家打字执行指令: ${cmd}`);
            this.bot.chat(cmd);

            const waitMs = (cmd.includes('rtp') || cmd.includes('spawn') || cmd.includes('warp') || cmd.includes('home')) ? 4500 : 1500;
            this.timer = setTimeout(() => {
                this.timer = null;
                if (this.isAborted) return resolve(false);
                const pos = this.bot.entity?.position;
                if (pos) {
                    this.log(`[CommandTask] 指令完成，当前坐标: [${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}]`);
                }
                resolve(true);
            }, waitMs);
        });
    }
}

// ----------------------------------------------------
// 2. LeaveLobbyTask: 真实玩家方式离开主城进入资源区
// ----------------------------------------------------
class LeaveLobbyTask {
    constructor(bot, spec, log) {
        this.bot = bot;
        this.spec = spec;
        this.log = log;
        this.isAborted = false;
        this.timer = null;
    }

    abort() {
        this.isAborted = true;
        if (this.timer) clearTimeout(this.timer);
    }

    execute() {
        return new Promise((resolve) => {
            if (this.isAborted) return resolve(false);
            this.log(`[LeaveLobbyTask] 正在通过玩家传送核心离开主城前往资源世界...`);

            let windowListener = null;
            const timeoutTimer = setTimeout(() => {
                cleanup();
                // 兜底直接敲 /rtp
                this.bot.chat('/rtp');
                resolve(true);
            }, 8000);

            const cleanup = () => {
                clearTimeout(timeoutTimer);
                if (windowListener) this.bot.removeListener('windowOpen', windowListener);
            };

            windowListener = async (window) => {
                try {
                    const title = String(window.title || '');
                    this.log(`[LeaveLobbyTask] 收到菜单界面: "${title}"`);
                    // 在 zy_menu 或 teleport_menu 中点击传送槽位 (slot 11 为进入主世界)
                    setTimeout(() => {
                        try {
                            this.bot.clickWindow(11, 0, 0);
                            this.log(`[LeaveLobbyTask] 已点击资源界传送槽位！等待传送落地...`);
                        } catch (e) {
                            this.log(`[LeaveLobbyTask] 点击菜单异常: ${e.message}`);
                        }
                    }, 500);

                    setTimeout(() => {
                        cleanup();
                        // 落地后补充一次 /rtp 前往林地矿山
                        this.bot.chat('/rtp');
                        resolve(true);
                    }, 3500);
                } catch (e) {
                    cleanup();
                    resolve(false);
                }
            };

            this.bot.once('windowOpen', windowListener);
            // 真实普通玩家打开资源区菜单指令
            this.bot.chat('/pa open zy_menu');
        });
    }
}

// ----------------------------------------------------
// 3. NavigateTask: 目标地点移动
// ----------------------------------------------------
class NavigateTask {
    constructor(bot, spec, log, manager) {
        this.bot = bot;
        this.spec = spec;
        this.log = log;
        this.manager = manager;
        this.isAborted = false;
    }

    abort() {
        this.isAborted = true;
        if (this.bot.pathfinder) {
            try { this.bot.pathfinder.setGoal(null); } catch (e) {}
        }
        this.bot.clearControlStates();
    }

    async execute() {
        if (this.isAborted || !this.bot.entity) return false;
        const x = Number(this.spec.x);
        const y = Number(this.spec.y ?? this.bot.entity.position.y);
        const z = Number(this.spec.z);
        if (![x, y, z].every(Number.isFinite)) return false;

        this.manager.activeMovementOwner = this;
        const radius = Number(this.spec.radius) || 2;
        const timeout = Number(this.spec.timeout) || 15000;
        const goal = new GoalNear(x, y, z, radius);

        const ok = await gotoSmart(this.bot, goal, timeout, this.log);
        if (this.manager.activeMovementOwner === this) this.manager.activeMovementOwner = null;
        return ok;
    }
}

// ----------------------------------------------------
// 4. CollectTask: 连续、抗反作弊、稳健射线采掘
// ----------------------------------------------------
class CollectTask {
    constructor(bot, spec, log, insertTaskFn, parentManager) {
        this.bot = bot;
        this.spec = spec;
        this.log = log;
        this.insertTask = insertTaskFn;
        this.parentManager = parentManager;
        this.isAborted = false;
    }

    abort() {
        this.isAborted = true;
        if (this.bot.pathfinder) {
            try { this.bot.pathfinder.setGoal(null); } catch (e) {}
        }
        this.bot.clearControlStates();
        if (this.parentManager && this.parentManager.activeMovementOwner === this) {
            this.parentManager.activeMovementOwner = null;
        }
    }

    async execute() {
        if (this.isAborted) return false;
        if (this.parentManager) this.parentManager.activeMovementOwner = this;
        const targetType = (this.spec.target || 'log').toLowerCase();
        const targetCount = parseInt(this.spec.count, 10) || 4;

        // 主城与和平保护区拦截
        const pos = this.bot.entity.position;
        const isPeacefulLobby = this.bot.game?.difficulty === 'peaceful' ||
            (Math.abs(pos.x - 319.5) < 272 && Math.abs(pos.z - (-131.5)) < 272);

        if (isPeacefulLobby) {
            this.log(`⚠️ [CollectTask 保护拦截] 当前在主城安全区 (禁止破坏方块)！`);
            this.log(`🚀 自动触发离开主城任务进入野外资源世界...`);
            this.insertTask({ task: 'collect', target: targetType, count: targetCount, desc: `开荒采集 ${targetType}` });
            this.insertTask({ task: 'leave_lobby', desc: '通过传送核心离开主城' });
            return true;
        }

        const mcData = require('minecraft-data')(this.bot.version);
        let blockIds = [];

        if (targetType === 'log' || targetType === 'wood') {
            blockIds = [
                mcData.blocksByName.oak_log?.id,
                mcData.blocksByName.birch_log?.id,
                mcData.blocksByName.spruce_log?.id,
                mcData.blocksByName.jungle_log?.id,
                mcData.blocksByName.acacia_log?.id,
                mcData.blocksByName.dark_oak_log?.id,
                mcData.blocksByName.cherry_log?.id,
                mcData.blocksByName.pale_oak_log?.id
            ].filter(Boolean);
        } else if (targetType === 'stone' || targetType === 'cobblestone') {
            blockIds = [
                mcData.blocksByName.stone?.id,
                mcData.blocksByName.cobblestone?.id,
                mcData.blocksByName.deepslate?.id,
                mcData.blocksByName.cobbled_deepslate?.id
            ].filter(Boolean);
        } else if (targetType.includes('coal')) {
            blockIds = [mcData.blocksByName.coal_ore?.id, mcData.blocksByName.deepslate_coal_ore?.id].filter(Boolean);
        } else if (targetType.includes('iron')) {
            blockIds = [mcData.blocksByName.iron_ore?.id, mcData.blocksByName.deepslate_iron_ore?.id].filter(Boolean);
        } else {
            const b = mcData.blocksByName[targetType];
            if (b) blockIds = [b.id];
        }

        if (blockIds.length === 0) {
            this.log(`[CollectTask] 未知方块类型: ${targetType}`);
            return false;
        }

        // 寻找附近 28 格内的目标方块
        const found = this.bot.findBlocks({
            matching: blockIds,
            maxDistance: 28,
            count: targetCount
        });

        if (found.length === 0) {
            this.log(`[CollectTask] 附近未搜寻到 [${targetType}]，自动漫游 25 格寻找新林区/矿区...`);
            this.insertTask({ task: 'collect', target: targetType, count: targetCount, desc: `继续寻找采集 ${targetType}` });
            this.insertTask({ task: 'explore', distance: 25, desc: '漫游探索矿林' });
            return true;
        }

        const blockTargets = found.map(p => this.bot.blockAt(p)).filter(Boolean);
        this.log(`[CollectTask] 锁定 ${blockTargets.length} 处 [${targetType}]，启动稳健采掘流水线...`);

        let collectedSuccess = 0;
        for (const block of blockTargets) {
            if (this.isAborted) break;
            if (!block || block.name === 'air') continue;

            const ok = await this.robustMineBlock(block, targetType);
            if (ok) collectedSuccess++;
        }

        if (collectedSuccess > 0) {
            this.log(`✔ [CollectTask] 成功采得 ${collectedSuccess} 块 ${targetType}！`);
            return true;
        }

        this.insertTask({ task: 'explore', distance: 20, desc: '换区域寻找可用资源' });
        return false;
    }

    // 稳健物理采掘：走近 -> 站稳 -> 6面射线检测 -> 切工具 -> 锁视角 -> 单次 dig -> 拾取
    async robustMineBlock(block, type) {
        if (this.isAborted || !this.bot.entity) return false;

        try {
            // 1. 走近到目标 3.5 格以内
            const dist = this.bot.entity.position.distanceTo(block.position);
            if (dist > 3.5) {
                const reached = await gotoSmart(
                    this.bot,
                    new GoalGetToBlock(block.position.x, block.position.y, block.position.z),
                    7000,
                    this.log
                );
                if (!reached && this.bot.entity.position.distanceTo(block.position) > 4.5) {
                    return false;
                }
            }

            // 走近后彻底站稳，清除移动按键，防止移动中挥镐触发反作弊回弹
            this.bot.clearControlStates();
            try { this.bot.pathfinder.setGoal(null); } catch (e) {}

            // 重新获取 liveBlock
            const liveBlock = this.bot.blockAt(block.position);
            if (!liveBlock || liveBlock.name === 'air') return true;

            // 2. 多面射线检测（确认真正能看到的有效面，严禁隔墙挖掘）
            const visibleFaceInfo = this.findVisibleFace(liveBlock);
            if (!visibleFaceInfo) {
                this.log(`[CollectTask] 目标 ${liveBlock.name} 被完全遮挡，杜绝隔墙挖掘，跳过: ${liveBlock.position}`);
                return false;
            }

            // 3. 切换最优挖掘工具并等待 150ms 服务端槽位确认
            await this.equipBestTool(type);
            await new Promise(r => setTimeout(r, 150));

            // 4. 视线锁定可见面接触点
            await this.bot.lookAt(visibleFaceInfo.targetPos, true);

            // 5. 标记正在挖掘，阻止自然转头打扰
            if (this.parentManager) this.parentManager.isDigging = true;
            this.log(`[CollectTask] 开始采掘 ${liveBlock.name} @ [${liveBlock.position.x}, ${liveBlock.position.y}, ${liveBlock.position.z}]`);

            // 单次完整 dig
            await this.bot.dig(liveBlock, 'ignore', visibleFaceInfo.face);

            // 留出 200ms 等待方块破碎包与掉落物实体生成
            await new Promise(r => setTimeout(r, 200));

            if (this.parentManager) this.parentManager.isDigging = false;

            // 6. 顺势走向方块中心吸取掉落物
            const afterBlock = this.bot.blockAt(liveBlock.position);
            if (!afterBlock || afterBlock.name === 'air') {
                await gotoSmart(this.bot, new GoalNear(liveBlock.position.x, liveBlock.position.y, liveBlock.position.z, 0.8), 2000, () => {});
                return true;
            }
        } catch (err) {
            this.log(`[CollectTask] 采掘中断: ${err.message}`);
        } finally {
            if (this.parentManager) this.parentManager.isDigging = false;
        }
        return false;
    }

    // 寻找真实暴露的方块面（Raycast 检测）
    findVisibleFace(block) {
        const eyePos = this.bot.entity.position.offset(0, this.bot.entity.eyeHeight, 0);
        const faces = [
            { face: { x: 0, y: 1, z: 0 }, pos: block.position.offset(0.5, 0.99, 0.5) }, // 上
            { face: { x: 0, y: -1, z: 0 }, pos: block.position.offset(0.5, 0.01, 0.5) }, // 下
            { face: { x: 0, y: 0, z: -1 }, pos: block.position.offset(0.5, 0.5, 0.01) }, // 北
            { face: { x: 0, y: 0, z: 1 }, pos: block.position.offset(0.5, 0.5, 0.99) },  // 南
            { face: { x: -1, y: 0, z: 0 }, pos: block.position.offset(0.01, 0.5, 0.5) }, // 西
            { face: { x: 1, y: 0, z: 0 }, pos: block.position.offset(0.99, 0.5, 0.5) }   // 东
        ];

        let bestFace = null;
        let minDistanceSq = Infinity;

        for (const f of faces) {
            const dir = f.pos.minus(eyePos);
            const dist = dir.norm();
            if (dist > 4.8) continue;

            const ray = this.bot.world.raycast(eyePos, dir.normalize(), dist + 0.2);
            if (ray && ray.position.equals(block.position)) {
                const dSq = eyePos.distanceSquared(f.pos);
                if (dSq < minDistanceSq) {
                    minDistanceSq = dSq;
                    bestFace = { face: f.face, targetPos: f.pos };
                }
            }
        }

        return bestFace;
    }

    async equipBestTool(type) {
        try {
            const items = this.bot.inventory.items();
            let tool = null;
            if (type.includes('log') || type.includes('wood')) {
                tool = items.find(i => i.name.includes('_axe'));
            } else if (type.includes('stone') || type.includes('ore') || type.includes('coal') || type.includes('iron')) {
                tool = items.find(i => i.name.includes('_pickaxe'));
            }
            if (tool) {
                await this.bot.equip(tool, 'hand');
            }
        } catch (ignored) {}
    }
}

// ----------------------------------------------------
// 5. CraftTask: 自动合成闭环 (planks -> table -> pickaxe)
// ----------------------------------------------------
class CraftTask {
    constructor(bot, spec, log) {
        this.bot = bot;
        this.spec = spec;
        this.log = log;
        this.isAborted = false;
    }

    abort() {
        this.isAborted = true;
    }

    async execute() {
        if (this.isAborted) return false;
        let targetItemName = (this.spec.item || '').toLowerCase();
        const mcData = require('minecraft-data')(this.bot.version);

        if (targetItemName === 'planks') {
            const logItem = this.bot.inventory.items().find(i => i.name.endsWith('_log'));
            targetItemName = logItem ? logItem.name.replace('_log', '_planks') : 'oak_planks';
        }

        const itemObj = mcData.itemsByName[targetItemName];
        if (!itemObj) {
            this.log(`[CraftTask] 未知合成物品: ${targetItemName}`);
            return false;
        }

        this.log(`[CraftTask] 正在合成: ${targetItemName}...`);
        try {
            // 1. 徒手 2x2 配方
            const simpleRecipes = this.bot.recipesFor(itemObj.id, null, 1, null);
            if (simpleRecipes.length > 0) {
                await this.bot.craft(simpleRecipes[0], 1, null);
                this.log(`✔ [CraftTask] 徒手合成成功: ${targetItemName}`);
                return true;
            }

            // 2. 借助工作台 3x3 配方
            let tableBlock = this.bot.findBlock({
                matching: mcData.blocksByName.crafting_table.id,
                maxDistance: 4
            });

            if (!tableBlock) {
                const tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');
                if (tableItem) {
                    const ground = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
                    if (ground && ground.boundingBox === 'block') {
                        await this.bot.equip(tableItem, 'hand');
                        await this.bot.placeBlock(ground, { x: 0, y: 1, z: 0 });
                        tableBlock = this.bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 4 });
                    }
                }
            }

            if (tableBlock) {
                const recipes = this.bot.recipesFor(itemObj.id, null, 1, tableBlock);
                if (recipes.length > 0) {
                    await this.bot.craft(recipes[0], 1, tableBlock);
                    this.log(`✔ [CraftTask] 借助工作台成功合成: ${targetItemName}`);
                    return true;
                }
            }
        } catch (e) {
            this.log(`[CraftTask] 合成异常: ${e.message}`);
        }
        return false;
    }
}

// ----------------------------------------------------
// 6. ExploreTask: 随机巡逻与探索
// ----------------------------------------------------
class ExploreTask {
    constructor(bot, spec, log, manager) {
        this.bot = bot;
        this.spec = spec;
        this.log = log;
        this.manager = manager;
        this.isAborted = false;
    }

    abort() {
        this.isAborted = true;
        if (this.bot.pathfinder) {
            try { this.bot.pathfinder.setGoal(null); } catch (e) {}
        }
    }

    async execute() {
        if (this.isAborted || !this.bot.entity) return false;
        const dist = parseInt(this.spec.distance, 10) || 20;
        const angle = Math.random() * Math.PI * 2;
        const targetX = Math.round(this.bot.entity.position.x + Math.cos(angle) * dist);
        const targetZ = Math.round(this.bot.entity.position.z + Math.sin(angle) * dist);

        this.log(`[ExploreTask] 漫游探索新坐标: [${targetX}, ~, ${targetZ}]...`);
        this.manager.activeMovementOwner = this;
        const goal = new GoalXZ(targetX, targetZ);
        const ok = await gotoSmart(this.bot, goal, 10000, this.log);
        if (this.manager.activeMovementOwner === this) this.manager.activeMovementOwner = null;
        return ok;
    }
}

// ----------------------------------------------------
// 7. FollowTask: 友好跟随玩家
// ----------------------------------------------------
class FollowTask {
    constructor(bot, spec, log, manager) {
        this.bot = bot;
        this.spec = spec;
        this.log = log;
        this.manager = manager;
        this.isAborted = false;
    }

    abort() {
        this.isAborted = true;
        if (this.bot.pathfinder) {
            try { this.bot.pathfinder.setGoal(null); } catch (e) {}
        }
    }

    execute() {
        return new Promise((resolve) => {
            if (this.isAborted) return resolve(false);
            const targetName = (this.spec.target || '').toLowerCase();
            const player = this.bot.nearestEntity(e => e.type === 'player' && e.username.toLowerCase() === targetName);

            if (!player) {
                this.log(`[FollowTask] 未在视野内找到玩家: ${targetName}`);
                return resolve(false);
            }

            this.log(`[FollowTask] 正在跟随玩家: ${player.username}`);
            this.manager.activeMovementOwner = this;
            this.bot.pathfinder.setGoal(new GoalFollow(player, 2.5), true);
            resolve(true);
        });
    }
}

// ----------------------------------------------------
// 8. CombatTask: 稳健打怪与遇袭自卫 (带 1.9+ 武器攻速冷却)
// ----------------------------------------------------
class CombatTask {
    constructor(bot, spec, log, manager) {
        this.bot = bot;
        this.spec = spec;
        this.log = log;
        this.manager = manager;
        this.isAborted = false;
    }

    abort() {
        this.isAborted = true;
        if (this.bot.pathfinder) {
            try { this.bot.pathfinder.setGoal(null); } catch (e) {}
        }
    }

    equipBestWeapon() {
        try {
            const items = this.bot.inventory.items();
            let weapon = items.find(i => i.name.includes('_sword')) ||
                         items.find(i => i.name.includes('_axe')) ||
                         items.find(i => i.name.includes('_pickaxe'));
            if (weapon) {
                this.bot.equip(weapon, 'hand').catch(() => {});
            }
        } catch (ignored) {}
    }

    execute() {
        return new Promise((resolve) => {
            if (this.isAborted || !this.bot.entity) return resolve(false);
            const targetType = (this.spec.target || 'hostile').toLowerCase();

            const mob = this.bot.nearestEntity(e => {
                if (!e || e === this.bot.entity) return false;
                if (e.type !== 'mob' && e.type !== 'hostile') return false;
                if (targetType !== 'hostile' && !e.name.toLowerCase().includes(targetType)) return false;
                return this.bot.entity.position.distanceTo(e.position) <= 24;
            });

            if (!mob) {
                this.log(`[CombatTask] 附近未发现目标敌对生物，战斗解除。`);
                return resolve(true);
            }

            this.log(`⚔️ [CombatTask] 锁定敌人: ${mob.name}，切出武器迎战！`);
            this.manager.activeMovementOwner = this;
            this.equipBestWeapon();

            let fightInterval = null;
            const timeoutTimer = setTimeout(() => {
                cleanup();
                resolve(true);
            }, 12000);

            const cleanup = () => {
                if (fightInterval) clearInterval(fightInterval);
                clearTimeout(timeoutTimer);
                if (this.bot.pathfinder) {
                    try { this.bot.pathfinder.setGoal(null); } catch (e) {}
                }
                if (this.manager?.activeMovementOwner === this) this.manager.activeMovementOwner = null;
            };

            fightInterval = setInterval(() => {
                if (this.isAborted || !mob || !mob.isValid || (mob.health !== undefined && mob.health <= 0)) {
                    cleanup();
                    this.log(`✔ [CombatTask] 敌人已被击溃！战斗结束。`);
                    return resolve(true);
                }

                // 生命值过低优先后撤
                if (this.bot.health < 6) {
                    cleanup();
                    this.log(`⚠️ [CombatTask] 血量过低 (${this.bot.health}/20)，紧急脱离战斗！`);
                    return resolve(false);
                }

                const dist = this.bot.entity.position.distanceTo(mob.position);
                if (dist > 3.0) {
                    this.bot.pathfinder.setGoal(new GoalFollow(mob, 2.0), true);
                } else {
                    // 进入攻击范围：对准敌人胸口挥刀（1.9+ 蓄力打击）
                    this.bot.lookAt(mob.position.offset(0, mob.height * 0.7, 0), true);
                    this.bot.attack(mob);
                }
            }, 620);
        });
    }
}

module.exports = TaskManager;
