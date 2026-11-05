# -*- coding: utf-8 -*-
import zipfile, os, io, sys
import soundfile as sf
from funasr import AutoModel

zdir = r'D:\ollama\voices\temp_zips'
out_base = r'D:\ollama\voices'

print('Loading Paraformer ASR model...')
asr_model = AutoModel(model='paraformer-zh', model_revision='v2.0.4', disable_update=True)
print('ASR Model loaded!')

characters = [
    ('hutao', 'Hu_Tao.zip', '胡桃'),
    ('ayaka', 'Kamisato_Ayaka.zip', '神里绫华'),
    ('raiden', 'Raiden_Shogun.zip', '雷电将军'),
    ('yae', 'Yae_Miko.zip', '八重神子'),
]

for char_id, zip_name, char_name in characters:
    zpath = os.path.join(zdir, zip_name)
    char_dir = os.path.join(out_base, char_id)
    os.makedirs(char_dir, exist_ok=True)
    
    with zipfile.ZipFile(zpath, 'r') as zf:
        namelist = [n for n in zf.namelist() if n.endswith('.wav')]
        selected_wav = None
        
        for name in namelist:
            data = zf.read(name)
            bio = io.BytesIO(data)
            try:
                info = sf.info(bio)
                if 4.0 <= info.duration <= 7.0:
                    selected_wav = (name, data, info.duration)
                    break
            except Exception:
                continue
                
        if selected_wav:
            wname, wdata, dur = selected_wav
            out_path = os.path.join(char_dir, 'reference.wav')
            with open(out_path, 'wb') as f:
                f.write(wdata)
            
            res = asr_model.generate(input=out_path, batch_size_s=300)
            text = res[0]['text']
            print(f'[{char_name}] (ID: {char_id}) - 时长: {dur:.2f}s')
            print(f'  文件: {out_path}')
            print(f'  台词: {text}')
        else:
            print(f'[{char_name}] 未找到合适时长的音频')
