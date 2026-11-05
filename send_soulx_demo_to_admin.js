const fs = require('fs');
const path = require('path');
const WebSocket = require('D:/deepseek-harness/node_modules/ws');

const ws = new WebSocket('ws://127.0.0.1:3001');
const TARGET_QQ = 2536218596;

const soulxBgmItems = [
    {
        type: 'text',
        content: `【大肥鱼歌声全面升级 · 立体声伴奏混音版已就绪！】\n老大！已为您完成两项深度调优升级：\n\n1. 【高品质立体声伴奏混音】：原声立体声伴奏 (0.75x) + 角色人声居中增强 (1.15x) + 广播级 -0.5 dBFS 峰值压限防爆音，听感丰满立体！\n2. 【SoulX-Singer 模型参数深度优化】：\n   • 采样步数由 24 提升至 32 步，声码器高频更细腻细腻自然；\n   • CFG 引导系数升级至 2.5，音色特征更鲜明；\n   • 严格遵循乐理八度对齐 (+12st / 0st)，彻底解决跑调与伴奏和弦冲突！\n\n请老大品鉴全新升级的带伴奏版本：`
    },
    {
        type: 'text',
        content: `━━━━━ 升级试听 ① ━━━━━\n【胡桃 · 俏皮元气少女音】\n《晴天》副歌 (SoulX-Singer 优化调优 + 立体声伴奏)：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\qingtian_hutao_soulx_bgm.wav'
    },
    {
        type: 'text',
        content: `━━━━━ 升级试听 ② ━━━━━\n【雷电将军 · 威严女王御姐音】\n《晴天》副歌 (SoulX-Singer 优化调优 + 立体声伴奏)：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\qingtian_raiden_soulx_bgm.wav'
    },
    {
        type: 'text',
        content: `━━━━━ 升级试听 ③ ━━━━━\n【神里绫华 · 端庄千金少女音】\n《青花瓷》副歌 (SoulX-Singer 优化调优 + 立体声伴奏)：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\qinghuaci_ayaka_soulx_bgm.wav'
    },
    {
        type: 'text',
        content: `━━━━━ 升级试听 ④ ━━━━━\n【可莉 · 元气天真萝莉音】\n《晴天》副歌 (SoulX-Singer 优化调优 + 立体声伴奏)：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\qingtian_klee_soulx_bgm.wav'
    },
    {
        type: 'text',
        content: `全部 8 款音色的《晴天》与《青花瓷》带伴奏高保真版本均已离线预渲染完毕，点歌极速秒出！在群里或私聊对我说「唱首歌」或「来首晴天」即可随时召唤大肥鱼欢快开唱！`
    }
];

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

ws.on('open', async () => {
    console.log('Connected to NapCat WebSocket!');
    
    for (let i = 0; i < soulxBgmItems.length; i++) {
        const item = soulxBgmItems[i];
        if (item.type === 'text') {
            console.log(`[${i+1}/${soulxBgmItems.length}] Sending text...`);
            ws.send(JSON.stringify({
                action: 'send_msg',
                params: {
                    user_id: TARGET_QQ,
                    message: item.content
                }
            }));
            await sleep(1500);
        } else if (item.type === 'voice') {
            console.log(`[${i+1}/${soulxBgmItems.length}] Sending voice: ${item.file}...`);
            if (fs.existsSync(item.file)) {
                ws.send(JSON.stringify({
                    action: 'send_msg',
                    params: {
                        user_id: TARGET_QQ,
                        message: [
                            {
                                type: 'record',
                                data: { file: item.file }
                            }
                        ]
                    }
                }));
            } else {
                console.warn(`File not found: ${item.file}`);
            }
            await sleep(2500);
        }
    }
    
    console.log('All SoulX BGM demo items queued! Waiting 4s before closing...');
    await sleep(4000);
    ws.close();
    process.exit(0);
});

ws.on('error', (err) => {
    console.error('WebSocket Error:', err);
    process.exit(1);
});
