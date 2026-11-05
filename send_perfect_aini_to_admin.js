const fs = require('fs');
const WebSocket = require('D:/deepseek-harness/node_modules/ws');

const ws = new WebSocket('ws://127.0.0.1:3001');
const TARGET_QQ = 2536218596;

const items = [
    {
        type: 'text',
        content: `【大肥鱼歌声再次精准进化 · 彻底剔除念白杂音！】\n老大英明！听感异常的根因彻底查明了：\n\n那句「爱就是由我装扮着你 轰轰烈烈」根本不是王心凌唱的，而是原曲伴奏里男声（王绍伟）的垫音念白 RAP！因为是低音念白且非主唱旋律，被算法强行识别并转给女角色翻唱后，听起来就会极其怪异和突兀！\n\n【本次终极优化】：\n1. 【精准重定黄金切片】：彻底切除前置男声念白，第一秒直接切入王心凌最甜、最洗脑的主旋律高潮——「情话多说一点，想我就多看一眼…」！\n2. 【连音平滑 + 律动 CFG 1.35】：清辅音微隙平滑过渡，顿挫感完全根除，丝滑到底！\n\n请老大品鉴全新出炉的完美纯净甜歌版：`
    },
    {
        type: 'text',
        content: `【胡桃 · 俏皮元气少女音】\n《爱你》黄金纯净副歌（无杂音·丝滑连音版）：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\aini_hutao_soulx_bgm.wav'
    },
    {
        type: 'text',
        content: `【芭芭拉 · 治愈系偶像甜妹音】\n《爱你》黄金纯净副歌（无杂音·丝滑连音版）：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\aini_barbara_soulx_bgm.wav'
    },
    {
        type: 'text',
        content: `【可莉 · 元气天真萝莉音】\n《爱你》黄金纯净副歌（无杂音·丝滑连音版）：`
    },
    {
        type: 'voice',
        file: 'D:\\deepseek-harness\\rvc\\songs\\aini_klee_soulx_bgm.wav'
    },
    {
        type: 'text',
        content: `这下开头第一秒就直接是心动主旋律了，顿挫和怪异念白全部消灭！老大听听看感觉如何~`
    }
];

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

ws.on('open', async () => {
    console.log('Connected to NapCat WebSocket!');
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type === 'text') {
            console.log(`[${i+1}/${items.length}] Sending text...`);
            ws.send(JSON.stringify({
                action: 'send_msg',
                params: {
                    user_id: TARGET_QQ,
                    message: item.content
                }
            }));
            await sleep(1500);
        } else if (item.type === 'voice') {
            console.log(`[${i+1}/${items.length}] Sending voice: ${item.file}...`);
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
            }
            await sleep(2500);
        }
    }
    console.log('Done, closing in 3s...');
    await sleep(3000);
    ws.close();
    process.exit(0);
});
