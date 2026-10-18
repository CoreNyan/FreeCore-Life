/**
 * FreeCore-Life 物理实体网关（推翻重构版）
 * ============================================
 * 1. 唯一移动控制权，消除抢镜头、抢转向问题。
 * 2. 移除重复的 collectBlock.collect 与 smoothWalkTo 冲突，所有采掘/移动/战斗完全交由 TaskManager 统一调度。
 * 3. 精确感知服务器环境：利用 difficulty 和边界判定 lobby / resource / tech 世界。
 * 4. 优化 entityHurt 与自动进食，自然转头仅在完全空闲时轻量运行。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const autoEat = require('mineflayer-auto-eat').loader;
const TaskManager = require('./TaskManager');

function log(...args) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`[${time}] [FreeCore-Life]`, ...args);
}

const configPath = path.join(__dirname, 'config.json');
let config = {};
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    log('配置加载成功:', JSON.stringify(config.server));
} catch (e) {
    log('读取配置文件失败:', e.message);
    process.exit(1);
}

// ----------------------------------------------------
// Redis 神经通讯总线
// ----------------------------------------------------
let redisPub = null;
let redisSub = null;

function createRedisClient(name) {
    const client = net.createConnection({
        host: config.redis?.host || '127.0.0.1',
        port: config.redis?.port || 6379
    });
    client.on('connect', () => {
        log(`Redis [${name}] 连接成功`);
        if (config.redis?.password) {
            sendRedisCmd(client, 'AUTH', config.redis.password);
        }
    });
    return client;
}

function sendRedisCmd(client, ...args) {
    if (!client || client.destroyed) return;
    let cmd = `*${args.length}\r\n`;
    for (const arg of args) {
        const s = String(arg);
        cmd += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
    }
    client.write(cmd);
}

function connectRedis() {
    redisPub = createRedisClient('PUB');
    redisPub.on('error', e => log('Redis-Pub 异常:', e.message));
    redisPub.on('close', () => setTimeout(connectRedis, 5000));

    redisSub = createRedisClient('SUB');
    redisSub.on('connect', () => {
        sendRedisCmd(redisSub, 'SUBSCRIBE', 'freecore:agent:mc:action');
        log('已成功订阅动作频道: freecore:agent:mc:action');
    });

    let subBuffer = '';
    redisSub.on('data', chunk => {
        subBuffer += chunk.toString('utf8');
        while (true) {
            const chanMarker = 'freecore:agent:mc:action';
            const chanIdx = subBuffer.indexOf(chanMarker);
            if (chanIdx === -1) break;

            const afterChan = subBuffer.slice(chanIdx + chanMarker.length);
            const bodyIdx = afterChan.indexOf('{');
            if (bodyIdx === -1) break;

            let openCount = 0;
            let endIdx = -1;
            let inString = false;
            let escape = false;

            for (let i = bodyIdx; i < afterChan.length; i++) {
                const char = afterChan[i];
                if (escape) {
                    escape = false;
                    continue;
                }
                if (char === '\\') {
                    escape = true;
                    continue;
                }
                if (char === '"') {
                    inString = !inString;
                    continue;
                }
                if (!inString) {
                    if (char === '{') openCount++;
                    else if (char === '}') {
                        openCount--;
                        if (openCount === 0) {
                            endIdx = i;
                            break;
                        }
                    }
                }
            }

            if (endIdx === -1) break;

            const jsonStr = afterChan.slice(bodyIdx, endIdx + 1);
            subBuffer = afterChan.slice(endIdx + 1);

            try {
                const actData = JSON.parse(jsonStr);
                handleCentralAction(actData);
            } catch (e) {
                log('解析动作 JSON 失败:', e.message);
            }
        }
        if (subBuffer.length > 32768) subBuffer = '';
    });

    redisSub.on('error', e => log('Redis-Sub 异常:', e.message));
    redisSub.on('close', () => setTimeout(connectRedis, 5000));
}

connectRedis();

// ----------------------------------------------------
// Blessing Skin Yggdrasil 外置验签登录
// ----------------------------------------------------
function authenticateYggdrasil() {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            agent: { name: 'Minecraft', version: 1 },
            username: config.auth.email,
            password: config.auth.password,
            clientToken: 'freecore-life-puppet'
        });

        const url = new URL(config.auth.yggdrasil_url + '/authserver/authenticate');
        const isHttps = url.protocol === 'https:';
        const client = isHttps ? https : http;

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = client.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const data = JSON.parse(body);
                        log(`Blessing Skin 验签成功! 角色名: ${data.selectedProfile.name}, UUID: ${data.selectedProfile.id}`);
                        resolve({
                            accessToken: data.accessToken,
                            clientToken: data.clientToken,
                            selectedProfile: data.selectedProfile
                        });
                    } catch (e) {
                        reject(new Error('解析验签响应失败: ' + e.message));
                    }
                } else {
                    reject(new Error(`验签失败 HTTP ${res.statusCode}: ${body}`));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// ----------------------------------------------------
// Mineflayer 实体肉身生命周期管理
// ----------------------------------------------------
let bot = null;
let isReconnecting = false;
let taskManager = null;
let followTarget = null;

async function launchBot() {
    if (bot) {
        try { bot.quit(); } catch (e) {}
        bot = null;
    }

    try {
        log('正在通过 Blessing Skin Yggdrasil API 进行外置验证...');
        const authResult = await authenticateYggdrasil();

        log(`正在连接 Minecraft 代理端 ${config.server.host}:${config.server.port}...`);
        bot = mineflayer.createBot({
            host: config.server.host,
            port: config.server.port,
            username: authResult.selectedProfile.name,
            session: {
                accessToken: authResult.accessToken,
                clientToken: authResult.clientToken,
                selectedProfile: authResult.selectedProfile
            },
            authServer: "http://127.0.0.1:25567/api/yggdrasil/authserver",
            sessionServer: "http://127.0.0.1:25567/api/yggdrasil/sessionserver",
            version: config.server.version || '1.21.4',
            auth: 'mojang',
            skipValidation: true,
            checkTimeoutInterval: 60000
        });

        bot.loadPlugin(pathfinder);
        bot.loadPlugin(autoEat);

        setupBotEvents(bot);
    } catch (err) {
        log('启动实体客户端失败:', err.message);
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (isReconnecting) return;
    isReconnecting = true;
    log(`等待 ${config.behavior.reconnect_delay_ms / 1000} 秒后重新召唤小可物理肉身...`);
    setTimeout(() => {
        isReconnecting = false;
        launchBot();
    }, config.behavior.reconnect_delay_ms || 5000);
}

function setupBotEvents(b) {
    b.on('spawn', () => {
        const pos = b.entity.position;
        log(`✨ 小可物理肉身已成功降临服务器！坐标: [${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}]`);

        // 初始化寻路与物理动作（反作弊友好、杜绝乱挖、杜绝垫高冒粒子）
        const defaultMove = new Movements(b);
        defaultMove.canDig = false;            // 寻路期间严禁破坏周围方块
        defaultMove.allow1by1towers = false;   // 严禁垫高
        defaultMove.dontMineChest = true;
        defaultMove.allowParkour = false;      // 关闭跑酷跳，保持平稳步行
        defaultMove.allowSprinting = true;     // 允许冲刺
        defaultMove.maxDropDown = 3;           // 适度下落
        defaultMove.canOpenDoors = true;
        defaultMove.scafoldingBlocks = [];     // 严禁走动时往脚下垫任何方块
        defaultMove.liquidCost = 3;

        b.pathfinder.setMovements(defaultMove);
        b.pathfinder.thinkTimeout = 6000;
        b.pathfinder.tickTimeout = 50;

        // 初始化重构后的 TaskManager 任务流引擎
        taskManager = new TaskManager(b, log, (cmd, ...args) => sendRedisCmd(redisPub, cmd, ...args));

        // 自动进食配置
        if (b.autoEat) {
            b.autoEat.options = {
                priority: 'foodPoints',
                startAt: 14,
                bannedFood: ['rotten_flesh', 'spider_eye', 'pufferfish', 'poisonous_potato', 'chorus_fruit']
            };
        }

        startNaturalBehaviors();
        startHealthReportLoop();
    });

    // 受到伤害或挨打事件（遇险中断自卫，精准识别伤害来源）
    let lastHurtReport = 0;
    b.on('entityHurt', (entity) => {
        if (entity === b.entity) {
            const now = Date.now();
            log(`💥 哎呀！小可物理肉身受到了伤害！当前生命值: ${b.health.toFixed(1)}/20`);

            // 识别真凶：附近最近的敌对生物或攻击者
            const attacker = b.nearestEntity(e =>
                e !== b.entity &&
                (e.type === 'mob' || e.type === 'hostile' || e.type === 'player') &&
                b.entity.position.distanceTo(e.position) <= 12
            );

            let attackerDesc = '环境伤害(跌落/窒息/岩浆/缺氧)';
            if (attacker) {
                attackerDesc = attacker.type === 'player' ? `玩家[${attacker.username}]` : `怪物[${attacker.name}]`;
            }

            if (now - lastHurtReport > 5000) {
                lastHurtReport = now;
                const hurtNotice = {
                    type: 'hurt',
                    health: b.health,
                    attacker: attacker ? (attacker.username || attacker.name) : 'environment',
                    message: `【游戏事件·受到伤害】来源: ${attackerDesc}，剩余血量: ${b.health.toFixed(0)}/20`
                };
                sendRedisCmd(redisPub, 'PUBLISH', 'freecore:agent:mc:life_event', JSON.stringify(hurtNotice));
            }

            // 遇袭自卫反击机制：通过统一调度器插入高优先级战斗任务
            if (taskManager && attacker && (attacker.type === 'mob' || attacker.type === 'hostile')) {
                log(`⚔️ [自卫反击] 遭到 ${attacker.name} 袭击，切换到战斗任务！`);
                taskManager.interruptWith({ task: 'fight', target: attacker.name, desc: `自卫击败 ${attacker.name}` });
            }
        }
    });

    b.on('death', () => {
        log('💀 小可物理肉身阵亡了！准备自动重生...');
        if (config.behavior.auto_respawn) {
            setTimeout(() => {
                try {
                    b.respawn();
                    log('✨ 小可物理肉身已在重生点复活！');
                } catch (e) {
                    log('自动重生异常:', e.message);
                }
            }, 1500);
        }
    });

    b.on('kicked', (reason) => {
        log('⚠️ 被服务器踢出连接:', typeof reason === 'object' ? JSON.stringify(reason) : reason);
        scheduleReconnect();
    });

    b.on('error', (err) => {
        log('⚠️ 实体客户端发生错误:', err.message);
    });

    b.on('end', () => {
        log('实体客户端与服务器断开连接。');
        scheduleReconnect();
    });
}

// ----------------------------------------------------
// 生理与环境状态定时上报中枢
// ----------------------------------------------------
let lastInventorySnapshot = {};
let reportTimer = null;
function startHealthReportLoop() {
    if (reportTimer) clearInterval(reportTimer);
    reportTimer = setInterval(() => {
        if (!bot || !bot.entity) return;
        try {
            const inventorySummary = {};
            for (const item of bot.inventory.items()) {
                inventorySummary[item.name] = (inventorySummary[item.name] || 0) + item.count;
            }

            const gainedItems = [];
            for (const [name, count] of Object.entries(inventorySummary)) {
                const prev = lastInventorySnapshot[name] || 0;
                if (count > prev) {
                    gainedItems.push({ name, delta: count - prev });
                }
            }
            lastInventorySnapshot = { ...inventorySummary };

            if (gainedItems.length > 0) {
                const desc = gainedItems.map(i => `${i.name}+${i.delta}`).join(', ');
                log(`🎒 背包检测到真实物资入包: ${desc}`);
                const gainEvent = {
                    type: 'item_gained',
                    items: gainedItems,
                    message: `【游戏事件·背包收获】小可在服里真实收获了物品: ${desc}`,
                    timestamp: Date.now()
                };
                sendRedisCmd(redisPub, 'PUBLISH', 'freecore:agent:mc:life_event', JSON.stringify(gainEvent));
            }

            const nearbyPlayers = [];
            for (const name in bot.players) {
                const p = bot.players[name];
                if (p && p.entity && p.username !== 'CoreNyan') {
                    const dist = bot.entity.position.distanceTo(p.entity.position);
                    if (dist <= 16) {
                        nearbyPlayers.push({ name: p.username, distance: Math.round(dist) });
                    }
                }
            }

            const dimension = bot.game?.dimension || 'overworld';
            const curPos = bot.entity.position;

            // 智能识别当前是否身处主城/大厅不可破坏区域
            const isPeaceful = bot.game?.difficulty === 'peaceful';
            const isNearSpawn = Math.abs(curPos.x - 319.5) < 272 && Math.abs(curPos.z - (-131.5)) < 272;
            const isSafeZone = isPeaceful || isNearSpawn;

            let currentWorldType = 'WILD_RESOURCE (野外资源区·可自由开荒)';
            if (isSafeZone) {
                currentWorldType = 'SPAWN_LOBBY (主城安全区·禁止破坏)';
            } else if (bot.game?.difficulty === 'hard') {
                currentWorldType = 'TECH_WORLD (生电服世界·困难)';
            }

            const stateReport = {
                type: 'physical_status',
                isOnline: true,
                health: Math.round(bot.health || 20),
                food: Math.round(bot.food || 20),
                dimension,
                worldType: currentWorldType,
                isSafeZone,
                pos: {
                    x: Math.round(curPos.x),
                    y: Math.round(curPos.y),
                    z: Math.round(curPos.z)
                },
                isBusy: taskManager ? taskManager.isBusy() : false,
                inventory: inventorySummary,
                nearbyPlayers,
                timestamp: Date.now()
            };

            sendRedisCmd(redisPub, 'PUBLISH', 'freecore:agent:mc:life_state', JSON.stringify(stateReport));
        } catch (e) {
            log('上报生理状态异常:', e.message);
        }
    }, 20000);
}

// ----------------------------------------------------
// 自然生物行为（仅在完全空闲时轻量转头看人）
// ----------------------------------------------------
let naturalTimer = null;
function startNaturalBehaviors() {
    if (naturalTimer) clearInterval(naturalTimer);

    naturalTimer = setInterval(() => {
        if (!bot || !bot.entity) return;

        // 核心约束：当任务流在运行或处于采掘中时，严禁插手转头！
        if (taskManager && taskManager.isBusy()) return;
        if (bot.pathfinder && bot.pathfinder.isMoving()) return;

        if (config.behavior.look_at_nearest_player && !followTarget) {
            const nearestPlayer = bot.nearestEntity(e =>
                e.type === 'player' &&
                e !== bot.entity &&
                e.username !== 'CoreNyan' &&
                bot.entity.position.distanceTo(e.position) <= (config.behavior.look_radius || 4.5)
            );

            if (nearestPlayer) {
                const eyePos = nearestPlayer.position.offset(0, 1.6, 0);
                bot.lookAt(eyePos, true);

                if (config.behavior.sneak_back_on_player_sneak && nearestPlayer.metadata?.[0] === 2) {
                    performSneakOnce();
                }
            }
        }
    }, 1500);
}

// ----------------------------------------------------
// 动作执行引擎（执行来自 CoreNyan 大脑的 Action 指令）
// ----------------------------------------------------
function handleCentralAction(data) {
    if (data.plan && Array.isArray(data.plan)) {
        log(`[LynxMind 任务下发] 接收到中枢 Plan 任务列表 (共 ${data.plan.length} 项)！`);
        if (taskManager) {
            taskManager.setPlan(data.plan, !!data.append);
        }
        return;
    }

    const action = String(data.action || '').trim();
    log(`收到中枢动作指令: "${action}" (来源: ${data.sender || 'CoreNyan'})`);

    if (action === 'disconnect' || action === 'sleep_disconnect') {
        if (bot) {
            log('💤 收到中枢休眠指令，小可物理肉身平滑退出服务器...');
            if (taskManager) taskManager.clearPlan();
            isReconnecting = true;
            bot.quit();
            bot = null;
        }
        return;
    } else if (action === 'connect' || action === 'wakeup_connect') {
        if (!bot) {
            log('⚡ 收到中枢唤醒指令，正在重新连接游戏服务器...');
            isReconnecting = false;
            launchBot();
        }
        return;
    }

    if (!bot || !bot.entity) return;

    if (action === 'stop' || action === 'clear_plan') {
        if (taskManager) taskManager.clearPlan();
        followTarget = null;
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
        log('已停止所有动作，清空计划队列，原地待命。');
        return;
    }

    if (action.startsWith('say:')) {
        const text = action.slice(4).trim();
        if (text) {
            log(`[实体说话] 小可在公屏打字: "${text}"`);
            bot.chat(text);
        }
        return;
    }

    if (action.startsWith('msg:')) {
        const parts = action.slice(4).trim().split(' ');
        const target = parts[0];
        const content = parts.slice(1).join(' ');
        if (target && content) {
            log(`[实体私聊] 小可实体私聊 ${target}: "${content}"`);
            bot.chat(`/msg ${target} ${content}`);
        }
        return;
    }

    if (action === 'sneak') {
        performSneak();
    } else if (action === 'jump') {
        performJump();
    } else if (action === 'nod') {
        performNod();
    } else if (action === 'shake') {
        performShake();
    } else if (action === 'arm') {
        bot.swingArm('right');
    } else if (action.startsWith('look:')) {
        const targetName = action.slice(5).trim();
        const pEntity = bot.nearestEntity(e => e.type === 'player' && e.username.toLowerCase() === targetName.toLowerCase());
        if (pEntity) {
            bot.lookAt(pEntity.position.offset(0, 1.6, 0), true);
        }
    } else if (action.startsWith('follow:')) {
        const targetName = action.slice(7).trim();
        if (taskManager) {
            taskManager.setPlan([{ task: 'follow', target: targetName, desc: `跟随玩家 ${targetName}` }], false);
        }
    } else if (action === 'toss') {
        performToss();
    } else if (action.startsWith('cmd:')) {
        const cmd = action.slice(4).trim();
        executePlayerCommand(cmd);
    }
}

// ----------------------------------------------------
// 动作细节实现
// ----------------------------------------------------
let isSneaking = false;
function performSneak() {
    if (isSneaking) return;
    isSneaking = true;
    bot.setControlState('sneak', true);
    setTimeout(() => {
        bot.setControlState('sneak', false);
        setTimeout(() => {
            bot.setControlState('sneak', true);
            setTimeout(() => {
                bot.setControlState('sneak', false);
                isSneaking = false;
            }, 250);
        }, 150);
    }, 250);
}

function performSneakOnce() {
    if (isSneaking) return;
    isSneaking = true;
    bot.setControlState('sneak', true);
    setTimeout(() => {
        bot.setControlState('sneak', false);
        isSneaking = false;
    }, 400);
}

function performJump() {
    bot.setControlState('jump', true);
    setTimeout(() => {
        bot.setControlState('jump', false);
    }, 350);
}

function performNod() {
    const curPitch = bot.entity.pitch;
    const curYaw = bot.entity.yaw;
    bot.look(curYaw, curPitch + 0.4, true, () => {
        setTimeout(() => {
            bot.look(curYaw, curPitch - 0.2, true, () => {
                setTimeout(() => {
                    bot.look(curYaw, curPitch, true);
                }, 150);
            });
        }, 150);
    });
}

function performShake() {
    const curPitch = bot.entity.pitch;
    const curYaw = bot.entity.yaw;
    bot.look(curYaw + 0.5, curPitch, true, () => {
        setTimeout(() => {
            bot.look(curYaw - 0.5, curPitch, true, () => {
                setTimeout(() => {
                    bot.look(curYaw, curPitch, true);
                }, 150);
            });
        }, 150);
    });
}

async function performToss() {
    try {
        const item = bot.inventory.items()[0];
        if (item) {
            await bot.toss(item.type, null, 1);
            log(`从背包扔出了一件物品送给面前的玩家: ${item.name}`);
        }
    } catch (e) {
        log('投掷物品失败:', e.message);
    }
}

// 严格受限的非 OP 指令安全执行器
function executePlayerCommand(cmd) {
    if (!cmd) return;
    const cleanCmd = cmd.startsWith('/') ? cmd : '/' + cmd;

    const FORBIDDEN_OP_REGEX = /^\/(op|deop|stop|restart|reload|ban|unban|kick|pardon|kill|gamemode|give|setblock|fill|execute|minecraft:)/i;
    if (FORBIDDEN_OP_REGEX.test(cleanCmd)) {
        log(`[安全防御拦截] 拒绝执行高危/OP指令: ${cleanCmd}`);
        return;
    }

    log(`[玩家实体指令] 发送游戏指令: ${cleanCmd}`);
    bot.chat(cleanCmd);
}

// 启动客户端
launchBot();
