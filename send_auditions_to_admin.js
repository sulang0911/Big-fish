const fs = require('fs');
const path = require('path');
const WebSocket = require('D:/deepseek-harness/node_modules/ws');

const ws = new WebSocket('ws://127.0.0.1:3001');

const TARGET_QQ = 2536218596;

const auditionItems = [
    {
        type: 'text',
        content: `【大肥鱼全新音色试听包】\n遵照老大要求，不选萝莉音，专门精选了 2 款少女音 + 2 款御姐音，风格各异，包含【日常撒娇语音】与【纯清唱歌曲《晴天》】双重试听，请老大品鉴：`
    },
    // 1. 少女音 1: 胡桃
    {
        type: 'text',
        content: `━━━━━ 少女音 ① ━━━━━\n【胡桃·往生堂堂主】\n• 风格：俏皮活泼、古灵精怪、通透元气的元气少女音\n• 日常说话试听：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\voices_audition\\audition_tts_hutao.wav'
    },
    {
        type: 'text',
        content: `• 胡桃《晴天》清唱效果：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\qingtian_hutao_cover.wav'
    },

    // 2. 少女音 2: 神里绫华
    {
        type: 'text',
        content: `━━━━━ 少女音 ② ━━━━━\n【神里绫华·白鹭公主】\n• 风格：端庄高雅、清丽温柔、如沐春风的千金少女音\n• 日常说话试听：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\voices_audition\\audition_tts_ayaka.wav'
    },
    {
        type: 'text',
        content: `• 神里绫华《晴天》清唱效果：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\qingtian_ayaka_cover.wav'
    },

    // 3. 御姐音 1: 雷电将军
    {
        type: 'text',
        content: `━━━━━ 御姐音 ① ━━━━━\n【雷电将军 / 影·鸣神尊者】\n• 风格：威严高冷、深沉霸气、至尊女王御姐音\n• 日常说话试听：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\voices_audition\\audition_tts_raiden.wav'
    },
    {
        type: 'text',
        content: `• 雷电将军《晴天》清唱效果：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\qingtian_raiden_cover.wav'
    },

    // 4. 御姐音 2: 八重神子
    {
        type: 'text',
        content: `━━━━━ 御姐音 ② ━━━━━\n【八重神子·大社宫司】\n• 风格：优雅从容、妩媚慵懒、戏谑调皮的大姐姐御姐音\n• 日常说话试听：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\voices_audition\\audition_tts_yae.wav'
    },
    {
        type: 'text',
        content: `• 八重神子《晴天》清唱效果：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\qingtian_yae_cover.wav'
    },

    {
        type: 'text',
        content: `以上 4 款音色均已在后台完成训练与歌声对齐。老大您听听看最喜欢哪几个，随时告诉我，我直接为您保留并设定为默认音色！`
    }
];

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

ws.on('open', async () => {
    console.log('Connected to NapCat WebSocket!');
    
    for (let i = 0; i < auditionItems.length; i++) {
        const item = auditionItems[i];
        let messagePayload = null;
        
        if (item.type === 'text') {
            console.log(`Sending text [${i+1}/${auditionItems.length}]...`);
            messagePayload = item.content;
        } else if (item.type === 'voice') {
            console.log(`Sending voice [${i+1}/${auditionItems.length}]: ${item.file}...`);
            messagePayload = [
                {
                    type: 'record',
                    data: {
                        file: item.file
                    }
                }
            ];
        }
        
        const req = {
            action: 'send_private_msg',
            params: {
                user_id: TARGET_QQ,
                message: messagePayload
            },
            echo: `msg_${i}`
        };
        
        ws.send(JSON.stringify(req));
        await sleep(1500); // 间隔 1.5 秒
    }
    
    console.log('All audition items queued! Waiting 3s before closing...');
    await sleep(3000);
    ws.close();
    process.exit(0);
});

ws.on('error', (e) => {
    console.error('WS Error:', e);
});
