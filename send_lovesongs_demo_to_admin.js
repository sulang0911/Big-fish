const fs = require('fs');
const WebSocket = require('D:/deepseek-harness/node_modules/ws');

const ws = new WebSocket('ws://127.0.0.1:3001');
const TARGET_QQ = 2536218596;

const loveSongItems = [
    {
        type: 'text',
        content: `【大肥鱼情歌库全面换新 · 非周杰伦经典情歌已上线！】\n老大！已根据您的要求彻底替换周杰伦歌曲，换上两首国民级浪漫情歌：\n\n1. 《爱你》（王心凌）—— 甜美元气、活泼欢快，极度契合元气少女与萝莉声线！\n2. 《小幸运》（田馥甄）—— 温暖治愈、深情细腻，极度契合温婉千金与御姐声线！\n\n【全链路技术细节】：\n• 严格截取 24.0s 黄金副歌高潮，平滑淡入淡出；\n• 采用原曲立体声伴奏混音（0.75x 伴奏扩展 + 1.15x 角色人声居中 + -0.5 dBFS 峰值压限）；\n• 女声原调（0 半音）直出，100% 契合原曲调性与和弦！\n\n请老大品鉴全新情歌试听：`
    },
    {
        type: 'text',
        content: `━━━━━ 甜蜜情歌试听 ① ━━━━━\n【胡桃 · 俏皮元气少女音】\n《爱你》（王心凌）24秒黄金副歌：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\aini_hutao_soulx_bgm.wav'
    },
    {
        type: 'text',
        content: `━━━━━ 甜蜜情歌试听 ② ━━━━━\n【芭芭拉 · 治愈系偶像甜妹音】\n《爱你》（王心凌）24秒黄金副歌：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\aini_barbara_soulx_bgm.wav'
    },
    {
        type: 'text',
        content: `━━━━━ 治愈情歌试听 ③ ━━━━━\n【神里绫华 · 端庄温婉千金少女音】\n《小幸运》（田馥甄）24秒黄金副歌：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\xiaoxingyun_ayaka_soulx_bgm.wav'
    },
    {
        type: 'text',
        content: `━━━━━ 治愈情歌试听 ④ ━━━━━\n【雷电将军 · 威严女王御姐音】\n《小幸运》（田馥甄）24秒黄金副歌：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\xiaoxingyun_raiden_soulx_bgm.wav'
    },
    {
        type: 'text',
        content: `━━━━━ 甜蜜情歌试听 ⑤ ━━━━━\n【可莉 · 元气天真萝莉音】\n《爱你》（王心凌）24秒黄金副歌：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\aini_klee_soulx_bgm.wav'
    },
    {
        type: 'text',
        content: `全部 8 款音色的《爱你》与《小幸运》带伴奏高保真版本已预渲染完成！在群聊或私聊只要对我说「唱首情歌」或「唱首歌」，肥鱼默认自动为您献唱甜甜的经典情歌，秒级秒出！`
    }
];

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

ws.on('open', async () => {
    console.log('Connected to NapCat WebSocket!');
    
    for (let i = 0; i < loveSongItems.length; i++) {
        const item = loveSongItems[i];
        if (item.type === 'text') {
            console.log(`[${i+1}/${loveSongItems.length}] Sending text...`);
            ws.send(JSON.stringify({
                action: 'send_msg',
                params: {
                    user_id: TARGET_QQ,
                    message: item.content
                }
            }));
            await sleep(1500);
        } else if (item.type === 'voice') {
            console.log(`[${i+1}/${loveSongItems.length}] Sending voice: ${item.file}...`);
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
    
    console.log('All love song demo items queued! Waiting 4s before closing...');
    await sleep(4000);
    ws.close();
    process.exit(0);
});

ws.on('error', (err) => {
    console.error('WebSocket Error:', err);
    process.exit(1);
});
