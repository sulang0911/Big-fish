#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
SO-VITS-SVC 4.1 高保真多音色唱歌翻唱生成器 (纯清唱模式 + 25s上限 + 动态音色自适应同步)
架构升级:
- 多音色模型库: 可莉 (40k高阶)、芙宁娜 (107k高阶)、纳西妲 (40k高阶)、胡桃 (40k高阶)
- 实时音色同步: 动态读取 voice_config.json 或传入 --voice，说话音色与唱歌音色 100% 自动同步
- 独立分音色缓存: 预置曲目与动态抓取歌曲均按音色进行独立缓存，秒级极速直出
- 基频与响度: FCPE 细粒度基频追踪 + 纯清唱 -1.0 dBFS 峰值平滑归一化
"""

import os
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import argparse
import json
import time
import re
import hashlib
import subprocess

SOVITS_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(SOVITS_DIR)
sys.path.insert(0, SOVITS_DIR)

# 限制线程数与内存保护
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ["OMP_NUM_THREADS"] = "2"
os.environ["MKL_NUM_THREADS"] = "2"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "max_split_size_mb:64"

MAX_SONG_DURATION = 18.0  # 截取 18s 供 UVR5 分离，混音时自动按乐句换气点对齐精简至 15~17s

# 多音色模型配置字典 (全角色 RVC v2 歌声高保真 + 立体声伴奏混音引擎)
RVC_WEIGHTS_DIR = r"D:\deepseek-harness\rvc\weights"

VOICE_MODELS = {
    "dafeiyu": {
        "name": "大肥鱼本鱼",
        "engine": "rvc",
        "model": os.path.join(RVC_WEIGHTS_DIR, "dafeiyu.pth"),
        "config": "",
        "cluster": "",
        "spk": "dafeiyu",
        "cluster_ratio": 0.0,
    },
    "klee": {
        "name": "可莉",
        "engine": "rvc",
        "model": os.path.join(RVC_WEIGHTS_DIR, "klee.pth"),
        "config": "",
        "cluster": "",
        "spk": "klee",
        "cluster_ratio": 0.0,
    },
    "furina": {
        "name": "芙宁娜",
        "engine": "rvc",
        "model": os.path.join(RVC_WEIGHTS_DIR, "furina.pth"),
        "config": "",
        "cluster": "",
        "spk": "furina",
        "cluster_ratio": 0.0,
    },
    "nahida": {
        "name": "纳西妲",
        "engine": "rvc",
        "model": os.path.join(RVC_WEIGHTS_DIR, "nahida.pth"),
        "config": "",
        "cluster": "",
        "spk": "nahida",
        "cluster_ratio": 0.0,
    },
    "hutao": {
        "name": "胡桃",
        "engine": "rvc",
        "model": os.path.join(RVC_WEIGHTS_DIR, "hutao.pth"),
        "config": "",
        "cluster": "",
        "spk": "hutao",
        "cluster_ratio": 0.0,
    },
    "ayaka": {
        "name": "神里绫华",
        "engine": "rvc",
        "model": os.path.join(RVC_WEIGHTS_DIR, "ayaka.pth"),
        "config": "",
        "cluster": "",
        "spk": "ayaka",
        "cluster_ratio": 0.0,
    },
    "raiden": {
        "name": "雷电将军",
        "engine": "rvc",
        "model": os.path.join(RVC_WEIGHTS_DIR, "raiden.pth"),
        "config": "",
        "cluster": "",
        "spk": "raiden",
        "cluster_ratio": 0.0,
    },
    "yae": {
        "name": "八重神子",
        "engine": "rvc",
        "model": os.path.join(RVC_WEIGHTS_DIR, "yae.pth"),
        "config": "",
        "cluster": "",
        "spk": "yae",
        "cluster_ratio": 0.0,
    },
    "barbara": {
        "name": "芭芭拉",
        "engine": "rvc",
        "model": os.path.join(RVC_WEIGHTS_DIR, "barbara.pth"),
        "config": "",
        "cluster": "",
        "spk": "barbara",
        "cluster_ratio": 0.0,
    },
    "diona": {
        "name": "迪奥娜",
        "engine": "rvc",
        "model": os.path.join(RVC_WEIGHTS_DIR, "diona.pth"),
        "config": "",
        "cluster": "",
        "spk": "diona",
        "cluster_ratio": 0.0,
    },
}

# 预置歌曲目录
SONGS_DIR = r"D:\deepseek-harness\rvc\songs"
CACHE_DIR = os.path.join(SONGS_DIR, "cache")

PRESETS = {
    "aini": {
        "title": "爱你 - 王心凌",
        "vocal": os.path.join(SONGS_DIR, "aini_vocal_24s.wav"),
        "inst": os.path.join(SONGS_DIR, "aini_instrument_24s.wav"),
        "output": os.path.join(SONGS_DIR, "aini_klee_soulx_bgm.wav"),
        "f0_up_key": 0,
        "alias": ["爱你", "aini", "王心凌", "甜歌", "情歌", "唱首情歌", "唱首歌", "来首歌", "欢快", "开心", "活泼", "甜妹", "元气"],
    },
    "xiaoxingyun": {
        "title": "小幸运 - 田馥甄",
        "vocal": os.path.join(SONGS_DIR, "xiaoxingyun_vocal_24s.wav"),
        "inst": os.path.join(SONGS_DIR, "xiaoxingyun_instrument_24s.wav"),
        "output": os.path.join(SONGS_DIR, "xiaoxingyun_klee_soulx_bgm.wav"),
        "f0_up_key": 0,
        "alias": ["小幸运", "xiaoxingyun", "田馥甄", "幸运", "我的少女时代", "忧伤", "伤感", "抒情", "难过", "催泪", "慢歌", "安静", "怀念", "青春", "悲伤", "失恋"],
    },
    "nuannuan": {
        "title": "暖暖 - 梁静茹",
        "alias": ["暖暖", "nuannuan", "梁静茹", "治愈", "温暖"],
    },
    "qingtian": {
        "title": "晴天 - 周杰伦",
        "vocal": os.path.join(SONGS_DIR, "qingtian_vocal_24s.wav"),
        "inst": os.path.join(SONGS_DIR, "qingtian_instrument_24s.wav"),
        "output": os.path.join(SONGS_DIR, "qingtian_klee_soulx_bgm.wav"),
        "f0_up_key": 12,
        "alias": ["晴天", "qingtian", "校园"],
    },
    "qinghuaci": {
        "title": "青花瓷 - 周杰伦",
        "vocal": os.path.join(SONGS_DIR, "qinghuaci_vocal_24s.wav"),
        "inst": os.path.join(SONGS_DIR, "qinghuaci_instrument_24s.wav"),
        "output": os.path.join(SONGS_DIR, "qinghuaci_klee_soulx_bgm.wav"),
        "f0_up_key": 12,
        "alias": ["青花瓷", "qinghuaci", "古风", "国风", "中国风", "烟雨江南"],
    },
}


def get_active_voice_key():
    """读取当前活跃音色配置，未配置时默认 dafeiyu"""
    cfg_path = r"D:\deepseek-harness\voice_config.json"
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                return cfg.get("active_voice", "dafeiyu")
        except Exception:
            pass
    return "dafeiyu"


def detect_key_offset(y, sr, artist_name=""):
    """
    自适应智能变调（男歌女唱黄金调性适配）：
    - 女声原唱 (如王心凌、田馥甄、梁静茹、邓紫棋): 保持原调 (0半音)
    - 男高音/极高音男声 (如林俊杰、周杰伦、张杰、华晨宇):
      专业女调翻唱升 5 半音 (+5st，纯四度女调)！
      原因：林俊杰副歌已在 Eb4~G4 (311~392Hz)，若死板升 12st 会飙到 800Hz+ 超高频引起破音和漏音；
      升 5st 则正好落入可莉/神子/芙宁娜最甜美清亮、咬字最清晰的黄金女高音区 (C5/D5 520Hz 附近)！
    - 普通/低沉男声 (如陈奕迅、薛之谦、李荣浩、毛不易):
      升 12 半音 (+12st，标准整八度女调)
    """
    import numpy as np
    import librosa

    # 1. 歌手元数据先验
    HIGH_TENOR_ARTISTS = ["林俊杰", "周杰伦", "张杰", "华晨宇", "周深", "汪苏泷", "陶喆", "王力宏", "信乐团", "苏打绿", "吴青峰"]
    FEMALE_ARTISTS = ["王心凌", "田馥甄", "梁静茹", "邓紫棋", "孙燕姿", "蔡依林", "张韶涵", "莫文蔚", "刘若英", "郁可唯", "单依纯", "张碧晨", "庄心妍", "容祖儿", "杨千嬅", "a-lin", "黄丽玲", "徐佳莹", "王菲", "那英", "韩红", "张靓颖"]
    NORMAL_MALE_ARTISTS = ["陈奕迅", "薛之谦", "李荣浩", "毛不易", "许嵩", "刀郎", "伍佰", "beyond", "黄家驹", "朴树", "许巍", "赵雷", "宋冬野", "周传雄", "林宥嘉", "萧敬腾"]

    art_lower = str(artist_name).lower()
    for a in HIGH_TENOR_ARTISTS:
        if a in art_lower:
            print(f"[KeyAuto] 命中男高音歌手【{a}】-> 升5半音 (黄金纯四度女调，保护高音不破不漏)")
            return 5
    for a in FEMALE_ARTISTS:
        if a in art_lower:
            print(f"[KeyAuto] 命中女歌手【{a}】-> 保持原调 (0半音)")
            return 0
    for a in NORMAL_MALE_ARTISTS:
        if a in art_lower:
            print(f"[KeyAuto] 命中男中低音歌手【{a}】-> 升12半音 (整八度女调)")
            return 12

    # 2. 声学基频分析
    try:
        f0 = librosa.yin(y, fmin=65, fmax=500, sr=sr)
        valid_f0 = f0[(f0 > 65) & (f0 < 450)]
        if len(valid_f0) > 0:
            median_f0 = float(np.median(valid_f0))
            p25_f0 = float(np.percentile(valid_f0, 25))
            if p25_f0 >= 220.0 or median_f0 >= 280.0:
                if p25_f0 < 200.0:
                    print(f"[KeyAuto] 声学分析为男高音 (低音 {p25_f0:.1f}Hz, 中位 {median_f0:.1f}Hz) -> 升5半音")
                    return 5
                else:
                    print(f"[KeyAuto] 声学分析为女声原调 (中位基频 {median_f0:.1f}Hz) -> 保持原调 (0半音)")
                    return 0
            elif median_f0 >= 200.0:
                print(f"[KeyAuto] 声学分析为男高音/高音歌曲 (中位基频 {median_f0:.1f}Hz) -> 升5半音")
                return 5
            else:
                print(f"[KeyAuto] 声学分析为普通/低沉男声 (中位基频 {median_f0:.1f}Hz) -> 升12半音")
                return 12
    except Exception as e:
        print(f"[KeyAuto] 音高分析异常 ({e}) -> 默认升5半音")
    return 5


def normalize_vocal(audio_data, target_peak_db=-1.0):
    """峰值平滑归一化至指定 dBFS，防止破音同时保证清唱声音饱满洪亮"""
    import numpy as np
    peak = np.max(np.abs(audio_data))
    if peak <= 0:
        return audio_data
    target_amp = 10.0 ** (target_peak_db / 20.0)
    gain = target_amp / peak
    return np.clip(audio_data * gain, -1.0, 1.0)


class DaFeiYuSoVitsSinger:
    def __init__(self, voice="klee", model_path=None, config_path=None, cluster_path=None, spk=None, cluster_ratio=None):
        self.voice = str(voice).lower().strip()
        v_info = VOICE_MODELS.get(self.voice, VOICE_MODELS["klee"])

        self.model_path = model_path or v_info["model"]
        self.config_path = config_path or v_info["config"]
        self.cluster_path = cluster_path if cluster_path is not None else v_info["cluster"]
        self.spk = spk or v_info["spk"]
        self.cluster_ratio = v_info["cluster_ratio"] if cluster_ratio is None else float(cluster_ratio)

        if not os.path.exists(self.model_path):
            print(f"[WARN] 音色【{self.voice}】模型文件不存在 ({self.model_path})，自动回退到经典可莉模型")
            v_info = VOICE_MODELS["klee"]
            self.model_path = v_info["model"]
            self.config_path = v_info["config"]
            self.cluster_path = v_info["cluster"]
            self.spk = v_info["spk"]
            self.cluster_ratio = v_info["cluster_ratio"]

        self.engine = v_info.get("engine", "sovits")
        self.svc = None

    def _get_svc(self):
        if self.svc is None:
            from inference.infer_tool import Svc
            print(f"[SO-VITS] 正在初始化回退歌声转换引擎 (音色: {self.voice}, spk: {self.spk})...")
            t0 = time.time()
            self.svc = Svc(
                net_g_path=self.model_path,
                config_path=self.config_path,
                cluster_model_path=self.cluster_path if (self.cluster_path and os.path.exists(self.cluster_path)) else "",
            )
            print(f"[SO-VITS] 模型加载完成，耗时 {time.time() - t0:.2f}s, 目标采样率: {self.svc.target_sample}Hz")
        return self.svc

    def convert(self, vocal_path, output_path, inst_path=None, key_offset="auto", cluster_ratio=None, f0_predictor="fcpe", artist_name=""):
        """将干声转换为当前音色清唱或混音音频 (有专属 RVC 模型的音色走 RVC，其余走 SO-VITS-SVC 4.1)"""
        if not os.path.exists(vocal_path):
            raise FileNotFoundError(f"输入音频不存在: {vocal_path}")

        # 1. 若当前音色拥有专属训练的 RVC 模型，优先直接调用 RVC 引擎（显存占用低、音准更稳且带立体声伴奏混音）
        if getattr(self, "engine", "sovits") == "rvc" and os.path.exists(self.model_path):
            actual_key = key_offset
            if actual_key is None or str(actual_key).lower() == "auto":
                try:
                    import librosa
                    y_check, sr_check = librosa.load(vocal_path, sr=22050, duration=6.0, mono=True)
                    actual_key = detect_key_offset(y_check, sr_check, artist_name=artist_name)
                except Exception:
                    actual_key = 5
            print(f"[RVC Engine] 启动专属 RVC 歌声转换与混音 (音色: {self.voice}, 变调: {actual_key:+d}st, 伴奏混音: {bool(inst_path)})...")
            cmd = [
                sys.executable,
                r"D:\deepseek-harness\rvc\rvc_sing.py",
                "--vocal", vocal_path,
                "--output", output_path,
                "--model", self.model_path,
                "--key", str(int(actual_key)),
                "--method", "rmvpe",
            ]
            if inst_path and os.path.exists(inst_path):
                cmd.extend(["--bgm", inst_path, "--with-bgm"])
            res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
            if os.path.exists(output_path) and os.path.getsize(output_path) > 1000:
                print(f"[RVC SUCCESS] 专属 RVC 翻唱已生成: {output_path}")
                return output_path
            print(f"[WARN] RVC 转换异常: {res.stderr or res.stdout}")

        # 2. 回退模式: SO-VITS-SVC 4.1
        import numpy as np
        import soundfile as sf
        import librosa
        import torch
        svc = self._get_svc()

        # 1. 读取音频并强制截断至 25.0 秒以内
        y, sr = librosa.load(vocal_path, sr=44100, mono=True)
        max_samples = int(MAX_SONG_DURATION * sr)
        if len(y) > max_samples:
            print(f"[Duration] 输入音频超过 {MAX_SONG_DURATION}s，截断前 {MAX_SONG_DURATION}s")
            y = y[:max_samples]

        # 2. 边缘淡入淡出 (0.05s)
        fade_len = int(0.05 * sr)
        if len(y) > 2 * fade_len:
            y[:fade_len] *= np.linspace(0, 1, fade_len)
            y[-fade_len:] *= np.linspace(1, 0, fade_len)

        # 3. 确定半音偏移量
        if key_offset is None or str(key_offset).lower() == "auto":
            tran = detect_key_offset(y, sr)
        else:
            tran = int(key_offset)
        print(f"[SO-VITS] 变调参数 tran = {tran:+d} 半音 (音色: {self.voice})")

        # 4. 临时保存标准采样率的 wav 供 slice_inference 读取
        temp_input = os.path.join(SOVITS_DIR, f"temp_input_{os.getpid()}.wav")
        sf.write(temp_input, y, sr)

        try:
            ratio = self.cluster_ratio if cluster_ratio is None else float(cluster_ratio)
            kwarg = {
                "raw_audio_path": temp_input,
                "spk": self.spk,
                "tran": tran,
                "slice_db": -40,
                "cluster_infer_ratio": ratio,
                "auto_predict_f0": False,
                "noice_scale": 0.4,
                "pad_seconds": 0.5,
                "clip_seconds": 0,
                "f0_predictor": f0_predictor,
                "loudness_envelope_adjustment": 1.0,
            }
            print(f"[SO-VITS] 开始推理 (音色: {self.voice}, F0预测器: {f0_predictor}, 聚类比: {ratio})...")
            t_infer = time.time()
            audio = svc.slice_inference(**kwarg)
            print(f"[SO-VITS] 推理完成，耗时 {time.time() - t_infer:.2f}s")

            # 5. 纯清唱峰值平滑归一化至 -1.0 dBFS
            norm_audio = normalize_vocal(audio, target_peak_db=-1.0)

            # 6. 保存最终翻唱音频
            os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
            sf.write(output_path, norm_audio, svc.target_sample)
            print(f"[SUCCESS] 翻唱音频已生成: {output_path} (音色: {self.voice}, 大小: {os.path.getsize(output_path)} 字节)")
            return output_path
        finally:
            if os.path.exists(temp_input):
                try: os.remove(temp_input)
                except: pass
            if torch.cuda.is_available():
                torch.cuda.empty_cache()


def assert_audible(path, min_rms=0.01):
    """静音/空音频拦截：RMS 过低(约 -40 dBFS 以下)视为合成失败，删除文件防止被发送或写入缓存"""
    import numpy as np
    import soundfile as sf
    data, _ = sf.read(path, dtype="float32")
    rms = float(np.sqrt(np.mean(np.square(data)))) if data.size else 0.0
    if rms < min_rms:
        try: os.remove(path)
        except Exception: pass
        raise RuntimeError(f"翻唱结果几乎是静音 (RMS={rms:.4f})，已丢弃: {path}")
    return path


def dynamic_sing_flow(song_query, voice=None):
    """
    全自动点歌流水线 (音色同步版):
    1. 自动同步当前音色
    2. 匹配预置歌曲 (秒级直出专属音色翻唱)
    3. 匹配动态缓存 (按歌曲+音色隔离缓存)
    4. 网易云搜索下载 -> 副歌切片 -> UVR5 人声分离 -> SO-VITS-SVC 4.1 清唱转换
    """
    if not voice:
        voice = get_active_voice_key()
    voice = str(voice).lower().strip()
    if voice not in VOICE_MODELS:
        voice = "klee"

    query_clean = song_query.strip().strip("《》\"'").strip()
    query_clean = re.sub(r'^(?:给我|帮我)?(?:唱一?首|来一?[首个]|点一?首|我想听|听一?首)\s*', '', query_clean)
    query_clean = re.sub(r'\s*(?:的歌曲?|代表作|成名曲|名曲|好听的歌)$', '', query_clean).strip()

    # 歌手或曲目泛指点歌 -> 映射为原唱官方版本的精准检索词
    ARTIST_REPRESENTATIVE_SONGS = {
        "林俊杰": ["曹操 林俊杰", "江南 林俊杰", "修炼爱情 林俊杰", "美人鱼 林俊杰", "小酒窝 林俊杰"],
        "jj": ["曹操 林俊杰", "江南 林俊杰", "修炼爱情 林俊杰", "小酒窝 林俊杰"],
        "曹操": ["曹操 林俊杰"],
        "江南": ["江南 林俊杰"],
        "修炼爱情": ["修炼爱情 林俊杰"],
        "美人鱼": ["美人鱼 林俊杰"],
        "小酒窝": ["小酒窝 林俊杰"],
        "周杰伦": ["青花瓷 周杰伦", "晴天 周杰伦", "稻香 周杰伦", "告白气球 周杰伦"],
        "jay": ["青花瓷 周杰伦", "晴天 周杰伦"],
        "晴天": ["晴天 周杰伦"],
        "青花瓷": ["青花瓷 周杰伦"],
        "稻香": ["稻香 周杰伦"],
        "告白气球": ["告白气球 周杰伦"],
        "陈奕迅": ["十年 陈奕迅", "孤勇者 陈奕迅", "富士山下 陈奕迅"],
        "十年": ["十年 陈奕迅"],
        "孤勇者": ["孤勇者 陈奕迅"],
        "富士山下": ["富士山下 陈奕迅"],
        "薛之谦": ["演员 薛之谦", "丑八怪 薛之谦"],
        "演员": ["演员 薛之谦"],
        "丑八怪": ["丑八怪 薛之谦"],
        "邓紫棋": ["泡沫 邓紫棋", "光年之外 邓紫棋", "多远都要在一起 邓紫棋"],
        "泡沫": ["泡沫 邓紫棋"],
        "光年之外": ["光年之外 邓紫棋"],
        "梁静茹": ["暖暖 梁静茹", "勇气 梁静茹"],
        "暖暖": ["暖暖 梁静茹"],
        "勇气": ["勇气 梁静茹"],
        "孙燕姿": ["遇见 孙燕姿", "绿光 孙燕姿"],
        "遇见": ["遇见 孙燕姿"],
        "王心凌": ["爱你 王心凌"],
        "田馥甄": ["小幸运 田馥甄"],
    }
    search_candidates = [query_clean]
    if query_clean.lower() in ARTIST_REPRESENTATIVE_SONGS:
        search_candidates = ARTIST_REPRESENTATIVE_SONGS[query_clean.lower()]

    # 0. 泛指点歌处理
    if not query_clean or query_clean in ["随便", "歌", "一首", "来一首", "唱首歌", "唱歌", "听听", "唱歌听听"]:
        query_clean = "爱你"
        search_candidates = ["爱你"]

    # 1. 优先检查预置歌曲
    for p_key, p_info in PRESETS.items():
        aliases = p_info.get("alias", [p_key])
        if any(a in query_clean for a in aliases) or any(a in query_clean.lower() for a in aliases):
            # 1. 优先检查当前音色的专属 SoulX-Singer 带伴奏预置翻唱
            soulx_bgm = os.path.join(SONGS_DIR, f"{p_key}_{voice}_soulx_bgm.wav")
            if os.path.exists(soulx_bgm):
                print(f"[SOULX BGM PRESET] 命中 SoulX-Singer 带立体声伴奏翻唱《{p_info['title']}》（音色: {voice}）")
                print(f"[SONG_TITLE] {p_info['title']}")
                print(f"[OUTPUT_COVER] {soulx_bgm}")
                return soulx_bgm

            # 2. 检查纯清唱 SoulX 预置翻唱
            soulx_preset = os.path.join(SONGS_DIR, f"{p_key}_{voice}_soulx_cover.wav")
            if os.path.exists(soulx_preset):
                print(f"[SOULX PRESET] 命中 SoulX-Singer 高保真翻唱《{p_info['title']}》（音色: {voice}）")
                print(f"[SONG_TITLE] {p_info['title']}")
                print(f"[OUTPUT_COVER] {soulx_preset}")
                return soulx_preset

            # 3. 检查当前音色的专属传统预置翻唱
            voice_preset = os.path.join(SONGS_DIR, f"{p_key}_{voice}_cover.wav")
            if os.path.exists(voice_preset):
                print(f"[PRESET] 命中预置歌曲《{p_info['title']}》（音色: {voice}）")
                print(f"[SONG_TITLE] {p_info['title']}")
                print(f"[OUTPUT_COVER] {voice_preset}")
                return voice_preset

            # 若音色是 klee 且默认 cover 存在
            if voice in ["klee", "dafeiyu"] and os.path.exists(p_info.get("output", "")):
                print(f"[PRESET] 命中经典预置歌曲《{p_info['title']}》（音色: {voice}）")
                print(f"[SONG_TITLE] {p_info['title']}")
                print(f"[OUTPUT_COVER] {p_info['output']}")
                return p_info["output"]

            # 若存在干声音频与伴奏，现场快速生成并缓存该音色版本
            if "vocal" in p_info and os.path.exists(p_info["vocal"]):
                print(f"[PRESET] 命中预置曲目《{p_info['title']}》，正在为音色【{voice}】生成带伴奏翻唱...")
                singer = DaFeiYuSoVitsSinger(voice=voice)
                singer.convert(vocal_path=p_info["vocal"], output_path=soulx_bgm, inst_path=p_info.get("inst"), key_offset="auto")
                assert_audible(soulx_bgm)
                print(f"[SONG_TITLE] {p_info['title']}")
                print(f"[OUTPUT_COVER] {soulx_bgm}")
                return soulx_bgm

    os.makedirs(CACHE_DIR, exist_ok=True)
    
    # 2. 检查动态缓存 (优先带伴奏 SoulX 缓存)
    safe_name = re.sub(r'[^\w\u4e00-\u9fa5]+', '_', query_clean).strip('_')
    safe_hash = hashlib.md5(f"{query_clean}_{voice}".encode('utf-8', errors='ignore')).hexdigest()[:8]
    cached_soulx_bgm = os.path.join(CACHE_DIR, f"{safe_name or 'song'}_{safe_hash}_{voice}_soulx_bgm.wav")
    if os.path.exists(cached_soulx_bgm):
        print(f"[SOULX BGM CACHE] 命中 SoulX-Singer 带伴奏缓存翻唱: {cached_soulx_bgm} (音色: {voice})")
        print(f"[SONG_TITLE] {query_clean}")
        print(f"[OUTPUT_COVER] {cached_soulx_bgm}")
        return cached_soulx_bgm
    cached_soulx = os.path.join(CACHE_DIR, f"{safe_name or 'song'}_{safe_hash}_{voice}_soulx_cover.wav")
    if os.path.exists(cached_soulx):
        print(f"[SOULX CACHE] 命中 SoulX-Singer 缓存翻唱音频: {cached_soulx} (音色: {voice})")
        print(f"[SONG_TITLE] {query_clean}")
        print(f"[OUTPUT_COVER] {cached_soulx}")
        return cached_soulx
    cached_cover = os.path.join(CACHE_DIR, f"{safe_name or 'song'}_{safe_hash}_{voice}_cover.wav")
    if os.path.exists(cached_cover):
        print(f"[CACHE] 命中缓存翻唱音频: {cached_cover} (音色: {voice})")
        print(f"[SONG_TITLE] {query_clean}")
        print(f"[OUTPUT_COVER] {cached_cover}")
        return cached_cover

    # 3. 搜索并下载有效音频
    import requests
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    search_url = 'https://music.163.com/api/search/get/web'
    
    downloaded_mp3 = None
    downloaded_artist = ""
    song_title = query_clean
    # 第一轮只接受原唱歌手的版本（遍历所有候选曲目），全部失败后第二轮才放宽到翻唱版
    for strict_artist in (True, False):
      for cand in search_candidates:
        if downloaded_mp3:
            break
        params = {'s': cand, 'type': 1, 'offset': 0, 'limit': 12}
        # 候选词形如 "修炼爱情 林俊杰" 时，第二段即期望的原唱歌手
        cand_parts = cand.split()
        expected_artist = cand_parts[1].lower() if len(cand_parts) > 1 else ''
        if strict_artist and not expected_artist:
            continue
        try:
            r = requests.get(search_url, params=params, headers=headers, timeout=6)
            songs = r.json().get('result', {}).get('songs', [])
            if expected_artist:
                is_orig = lambda s: any(expected_artist in str(a.get('name', '')).lower() for a in s.get('artists', []))
                songs = [s for s in songs if is_orig(s)] if strict_artist else sorted(songs, key=lambda s: 0 if is_orig(s) else 1)
            for s in songs:
                name = s.get('name', '')
                if any(w in name.lower() for w in ['伴奏', 'instrumental', 'inst', 'beat', '伴奏版', '纯音乐', '的歌']):
                    continue
                sid = s.get('id')
                artist = s.get('artists', [{}])[0].get('name')
                stream = f'http://music.163.com/song/media/outer/url?id={sid}.mp3'
                try:
                    resp = requests.get(stream, headers=headers, timeout=8)
                    if resp.status_code == 200 and 'audio' in str(resp.headers.get('content-type', '')) and len(resp.content) > 150000:
                        temp_mp3 = os.path.join(CACHE_DIR, f"temp_{os.getpid()}_raw.mp3")
                        with open(temp_mp3, 'wb') as f:
                            f.write(resp.content)
                        downloaded_mp3 = temp_mp3
                        downloaded_artist = str(artist or "")
                        song_title = f"{name} - {artist}"
                        print(f"[SEARCH] 成功搜索并下载音源: 《{song_title}》 ({len(resp.content)} bytes)")
                        break
                except Exception:
                    continue
        except Exception as e:
            print(f"[WARN] 音乐搜索接口异常: {e}")

    if not downloaded_mp3:
        is_sad = any(w in query_clean for w in ["忧伤", "伤感", "难过", "悲伤", "抒情", "催泪", "慢", "静", "哭", "泪", "遗憾", "痛", "失恋"])
        fb_key = "xiaoxingyun" if is_sad else "aini"
        fb_title = PRESETS[fb_key]["title"]
        fallback_cover = os.path.join(SONGS_DIR, f"{fb_key}_{voice}_soulx_bgm.wav")
        if not os.path.exists(fallback_cover):
            fallback_cover = PRESETS[fb_key]["output"]
        print(f"[FALLBACK] 未搜索到《{query_clean}》有效音频，回退至《{fb_title}》（音色: {voice}）")
        print(f"[SONG_TITLE] {fb_title}")
        print(f"[OUTPUT_COVER] {fallback_cover}")
        return fallback_cover

    # 4. 截取 16~18 秒精华片段（对齐换气低谷 + 预留 0.8s 伴奏前奏铺垫）
    import numpy as np
    import soundfile as sf
    import librosa
    temp_clip_wav = os.path.join(CACHE_DIR, f"temp_{os.getpid()}_clip.wav")
    try:
        y, sr = librosa.load(downloaded_mp3, sr=44100, mono=True)
        total_sec = len(y) / sr
        target_samples = int(MAX_SONG_DURATION * sr)
        if total_sec <= MAX_SONG_DURATION:
            clip = y
        else:
            hop_length = 2205  # 50ms 细粒度能量帧
            rms = librosa.feature.rms(y=y, frame_length=4410, hop_length=hop_length)[0]
            frames_len = int(15.0 * sr / hop_length)
            skip_frames = int(16 * sr / hop_length)
            if len(rms) > frames_len + skip_frames:
                search_rms = rms[skip_frames:]
                rolling = np.convolve(search_rms, np.ones(frames_len), mode='valid')
                peak_start = skip_frames + int(np.argmax(rolling))
                # 在高潮起点前 2.2s ~ 后 0.5s 寻找换气低谷，并再往前多留 0.75s 伴奏铺垫
                win_lo = max(0, peak_start - int(2.2 * sr / hop_length))
                win_hi = min(len(rms) - 1, peak_start + int(0.5 * sr / hop_length))
                valley_idx = win_lo + int(np.argmin(rms[win_lo : win_hi + 1]))
                lead_frames = int(0.75 * sr / hop_length)
                best_start = max(0, valley_idx - lead_frames)
                start_sample = best_start * hop_length
            else:
                start_sample = 0
            clip = y[start_sample : start_sample + target_samples]

        in_fade = int(0.6 * sr)
        out_fade = int(1.5 * sr)
        if len(clip) > in_fade + out_fade:
            clip[:in_fade] *= 0.5 * (1.0 - np.cos(np.pi * np.linspace(0, 1, in_fade)))
            clip[-out_fade:] *= 0.5 * (1.0 + np.cos(np.pi * np.linspace(0, 1, out_fade)))

        sf.write(temp_clip_wav, clip, sr)
        print(f"[CLIP] 乐句对齐切片完成 (时长: {len(clip)/sr:.1f}s)")
    except Exception as e:
        print(f"[WARN] 切片分析失败，直接使用原音频: {e}")
        temp_clip_wav = downloaded_mp3

    # 5. 调用独立 UVR5 进程分离人声与伴奏
    print("[UVR5] 启动独立子进程分离人声与伴奏...")
    rvc_dir = r"D:\deepseek-harness\rvc"
    sep_script = os.path.join(rvc_dir, "separate_stems.py")
    sep_cmd = [sys.executable, sep_script, "--input", temp_clip_wav, "--output_dir", CACHE_DIR]
    vocal_stem = os.path.join(CACHE_DIR, f"vocal_{os.path.basename(temp_clip_wav)}_10.wav")
    inst_stem = os.path.join(CACHE_DIR, f"instrument_{os.path.basename(temp_clip_wav)}_10.wav")
    try:
        sub_res = subprocess.run(sep_cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
        if not (os.path.exists(vocal_stem) and os.path.exists(inst_stem)):
            print(f"[UVR5 WARN] 分离未生成双轨文件 ({sub_res.stderr})，降级使用原切片音频直接转换...")
            vocal_stem = temp_clip_wav
            inst_stem = None
    except Exception as e:
        print(f"[UVR5 WARN] 分离子进程超时或异常 ({e})，降级使用原切片音频直接转换...")
        vocal_stem = temp_clip_wav
        inst_stem = None

    # 6. 歌声转换 (带伴奏混音，使用当前同步音色)；无论成败都清理临时过程文件
    try:
        singer = DaFeiYuSoVitsSinger(voice=voice)
        singer.convert(vocal_path=vocal_stem, output_path=cached_soulx_bgm, inst_path=inst_stem, key_offset="auto", artist_name=downloaded_artist)
        assert_audible(cached_soulx_bgm)
    finally:
        for f in [downloaded_mp3, temp_clip_wav, vocal_stem, inst_stem]:
            if f and os.path.exists(f):
                try: os.remove(f)
                except Exception: pass

    print(f"[SONG_TITLE] {song_title}")
    print(f"[OUTPUT_COVER] {cached_soulx_bgm}")
    return cached_soulx_bgm


def main():
    parser = argparse.ArgumentParser(description="SO-VITS-SVC 4.1 大肥鱼高保真多音色唱歌翻唱工具")
    parser.add_argument("--song", type=str, help="全自动搜索、下载、分离并翻唱指定歌曲")
    parser.add_argument("--voice", type=str, default=None, help="目标音色 (klee/furina/nahida/hutao/barbara/diona)")
    parser.add_argument("--vocal", help="输入的干声音频路径")
    parser.add_argument("--output", help="输出的翻唱音频路径")
    parser.add_argument("--key", default="auto", help="变调半音数 (如 12, 0, -12, auto)")
    parser.add_argument("--cluster-ratio", type=float, default=None, help="聚类模型融合比 (0.0~1.0)")
    parser.add_argument("--f0-predictor", default="fcpe", choices=["fcpe", "pm", "crepe", "dio", "harvest"], help="F0 预测器")

    args = parser.parse_args()

    if args.song:
        dynamic_sing_flow(args.song, voice=args.voice)
    elif args.vocal and args.output:
        singer = DaFeiYuSoVitsSinger(voice=args.voice or "klee")
        singer.convert(
            vocal_path=args.vocal,
            output_path=args.output,
            key_offset=args.key,
            cluster_ratio=args.cluster_ratio,
            f0_predictor=args.f0_predictor,
        )
        print(f"[OUTPUT_COVER] {args.output}")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
