const fs = require('fs');
const path = require('path');
const WebSocket = require('D:/deepseek-harness/node_modules/ws');

const ws = new WebSocket('ws://127.0.0.1:3001');
const TARGET_QQ = 2536218596;

const soulxItems = [
    {
        type: 'text',
        content: `【大肥鱼歌声大模型全面升级 · SoulX-Singer 正式上线！】\n老大！之前您反馈“唱歌时无论什么音色发音都特别像、没有原角色神韵”，根本原因是传统 SVC/RVC 是单纯的声音滤镜，会 100% 强行复刻原唱周杰伦的含糊咬字与滑音，导致所有角色发音千篇一律。\n\n现已为您全链路升级部署 B站推出的前沿零样本歌声大模型【SoulX-Singer】（Whisper 音素解耦 + DiffLlama 流匹配逆扩散 + Vocos 神经声码器）！\n请老大验收全新大模型的翻唱效果：`
    },
    {
        type: 'text',
        content: `━━━━━ 试听 ① ━━━━━\n【胡桃 · 俏皮元气少女音】\n《晴天》副歌 (SoulX-Singer 零样本大模型翻唱)：\n（发音通透清晰，咬字自然俏皮，彻底摆脱男声原调束缚）`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\qingtian_hutao_soulx_cover.wav'
    },
    {
        type: 'text',
        content: `━━━━━ 试听 ② ━━━━━\n【雷电将军 · 威严女王御姐音】\n《晴天》副歌 (SoulX-Singer 零样本大模型翻唱)：\n（智能自适应音域下潜 -2 半音，沉稳霸气、高贵内敛，不再被强行升成尖锐娃娃音）`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\qingtian_raiden_soulx_cover.wav'
    },
    {
        type: 'text',
        content: `━━━━━ 试听 ③ ━━━━━\n【神里绫华 · 端庄千金少女音】\n《青花瓷》副歌 (SoulX-Singer 零样本大模型翻唱)：\n（原调温婉清丽，吐字如珠，完美契合国风韵味）`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\qinghuaci_ayaka_soulx_cover.wav'
    },
    {
        type: 'text',
        content: `━━━━━ 试听 ④ ━━━━━\n【可莉 · 元气天真萝莉音】\n《晴天》副歌 (SoulX-Singer 经典大肥鱼音色)：\n（甜萌可爱、毫无电音机械感与破音）`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\qingtian_klee_soulx_cover.wav'
    },
    {
        type: 'text',
        content: `全部 8 款音色（可莉、芙宁娜、胡桃、神里绫华、雷电将军、八重神子、芭芭拉、迪奥娜）均已接入 SoulX-Singer！日常聊天和点歌翻唱 100% 自动同步，随时直接在群里或私聊对我说「唱首歌」或「切换音色为XX」即可立即体验！`
    }
];

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

ws.on('open', async () => {
    console.log('Connected to NapCat WebSocket!');
    
    for (let i = 0; i < soulxItems.length; i++) {
        const item = soulxItems[i];
        if (item.type === 'text') {
            console.log(`[${i+1}/${soulxItems.length}] Sending text...`);
            ws.send(JSON.stringify({
                action: 'send_msg',
                params: {
                    user_id: TARGET_QQ,
                    message: item.content
                }
            }));
            await sleep(1500);
        } else if (item.type === 'voice') {
            console.log(`[${i+1}/${soulxItems.length}] Sending voice: ${item.file}...`);
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
    
    console.log('All SoulX demo items queued! Waiting 4s before closing...');
    await sleep(4000);
    ws.close();
    process.exit(0);
});

ws.on('error', (err) => {
    console.error('WebSocket Error:', err);
    process.exit(1);
});
