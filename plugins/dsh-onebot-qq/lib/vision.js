import fs from 'node:fs';
import http from 'node:http';

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;

let cachedModel = null;
let lastCheckTime = 0;

/**
 * 探测 Ollama 当前已下载的最佳视觉模型
 * 优先级：minicpm-v (中文视觉最佳) -> moondream (轻量快速) -> 其他 vision 模型
 */
async function getVisionModel() {
    const now = Date.now();
    if (cachedModel && now - lastCheckTime < 60000) {
        return cachedModel;
    }

    return new Promise((resolve) => {
        const req = http.request({
            hostname: OLLAMA_HOST,
            port: OLLAMA_PORT,
            path: '/api/tags',
            method: 'GET',
            timeout: 2000
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const models = (json.models || []).map(m => m.name || m.model || '');
                    
                    if (models.some(m => m.includes('minicpm-v'))) {
                        cachedModel = 'minicpm-v';
                    } else if (models.some(m => m.includes('moondream'))) {
                        cachedModel = 'moondream';
                    } else {
                        // 寻找任何包含 vision 或 vl 的模型
                        const anyVision = models.find(m => m.includes('vision') || m.includes('vl') || m.includes('llava'));
                        cachedModel = anyVision || null;
                    }
                    lastCheckTime = now;
                    resolve(cachedModel);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
        req.end();
    });
}

/**
 * 使用本地 Ollama 视觉模型识别图片内容并返回中文画面描述
 * @param {string} imagePath 本地图片绝对路径
 * @returns {Promise<string|null>} 画面文字描述或 null
 */
export async function describeImage(imagePath) {
    try {
        if (!fs.existsSync(imagePath)) return null;

        const model = await getVisionModel();
        if (!model) return null;

        const imageBuf = await fs.promises.readFile(imagePath);
        const imageBase64 = imageBuf.toString('base64');

        const prompt = model.includes('minicpm-v')
            ? '这是一张聊天中收到的图片。请用中文简明生动地描述画面核心内容、人物/二次元角色（如大肥鱼/鲸鱼娘/猫咪/人物等）、姿态动作、神情表情以及图中的关键文字（1~2句话，适合聊天交流）：'
            : '请用中文简短描述这张图片的内容、角色、动作表情以及文字（1~2句话）：';

        const payload = JSON.stringify({
            model,
            prompt,
            images: [imageBase64],
            stream: false
        });

        return await new Promise((resolve) => {
            const req = http.request({
                hostname: OLLAMA_HOST,
                port: OLLAMA_PORT,
                path: '/api/generate',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                },
                timeout: 35000
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        let text = (parsed.response || '').trim();
                        // 去除多余的 Markdown 标记或前缀
                        text = text.replace(/^["'“”]|["'“”]$/g, '').replace(/\n+/g, ' ').slice(0, 300);
                        if (text.length > 3) {
                            console.log(`[dsh-onebot] 视觉模型(${model})识别结果: ${text}`);
                            resolve(text);
                        } else {
                            resolve(null);
                        }
                    } catch {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => {
                req.destroy();
                resolve(null);
            });
            req.write(payload);
            req.end();
        });
    } catch (e) {
        console.warn('[dsh-onebot] 视觉识别异常:', e.message);
        return null;
    }
}
