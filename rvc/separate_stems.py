import os
import sys

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
uvr5_dir = "D:/ollama/GPT-SoVITS-v2pro/GPT-SoVITS-v2pro-20250604/tools/uvr5"
sys.path.append(uvr5_dir)
from vr import AudioPre

def separate_song(inp_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    model_path = os.path.join(uvr5_dir, "uvr5_weights", "HP5_only_main_vocal.pth")
    
    print(f"Loading UVR5 model {model_path}...")
    pre_fun = AudioPre(
        agg=10,
        model_path=model_path,
        device="cuda:0",
        is_half=False
    )
    
    print(f"Separating {inp_path} into vocals and instrumental...")
    # _path_audio_(self, music_file, ins_root=None, vocal_root=None, format='flac', is_hp3=False)
    pre_fun._path_audio_(inp_path, ins_root=out_dir, vocal_root=out_dir, format="wav", is_hp3=False)
    print("[SUCCESS] Separation completed!")

if __name__ == "__main__":
    songs_dir = "D:/deepseek-harness/rvc/songs"
    for name in ["qingtian_clip.wav", "qinghuaci_clip.wav"]:
        p = os.path.join(songs_dir, name)
        separate_song(p, songs_dir)
