from pathlib import Path
from PIL import Image
import subprocess

SRC = Path('/Users/michaelbuttsworth/Downloads/Untitled-2/Group 1.svg')
OUT = Path('/Users/michaelbuttsworth/Documents/New project/brand-assets')

(OUT / 'logo').mkdir(parents=True, exist_ok=True)
(OUT / 'icon').mkdir(parents=True, exist_ok=True)
(OUT / 'social').mkdir(parents=True, exist_ok=True)
(OUT / 'web').mkdir(parents=True, exist_ok=True)

master = OUT / 'logo' / 'motioncoach-logo-master-3072x2048.png'
subprocess.run(['rsvg-convert', '-w', '3072', '-h', '2048', str(SRC), '-o', str(master)], check=True)
img = Image.open(master).convert('RGBA')

for w, h, name in [
    (1536, 1024, 'motioncoach-logo-1536x1024.png'),
    (1200, 800, 'motioncoach-logo-1200x800.png'),
    (768, 512, 'motioncoach-logo-768x512.png'),
    (512, 341, 'motioncoach-logo-512x341.png'),
    (384, 256, 'motioncoach-logo-384x256.png'),
]:
    img.resize((w, h), Image.Resampling.LANCZOS).save(OUT / 'logo' / name)

W, H = img.size
crop = img.crop((int(W * 0.23), int(H * 0.05), int(W * 0.77), int(H * 0.68)))
bbox = crop.getbbox()
if bbox:
    crop = crop.crop(bbox)
mark = crop.resize((1024, 1024), Image.Resampling.LANCZOS)
mark.save(OUT / 'icon' / 'motioncoach-mark-1024.png')

for s in [16, 32, 48, 57, 60, 72, 76, 96, 114, 120, 128, 144, 152, 167, 180, 192, 256, 384, 512, 1024]:
    mark.resize((s, s), Image.Resampling.LANCZOS).save(OUT / 'icon' / f'icon-{s}.png')

social_og = Image.new('RGBA', (1200, 630), (245, 245, 245, 255))
logo_for_og = img.resize((900, 600), Image.Resampling.LANCZOS)
social_og.alpha_composite(logo_for_og, ((1200 - 900) // 2, (630 - 600) // 2))
social_og.convert('RGB').save(OUT / 'social' / 'og-image-1200x630.jpg', quality=95)

social_sq = Image.new('RGBA', (1080, 1080), (245, 245, 245, 255))
logo_for_sq = img.resize((900, 600), Image.Resampling.LANCZOS)
social_sq.alpha_composite(logo_for_sq, ((1080 - 900) // 2, (1080 - 600) // 2))
social_sq.convert('RGB').save(OUT / 'social' / 'social-square-1080x1080.jpg', quality=95)

mark.resize((1024, 1024), Image.Resampling.LANCZOS).save(OUT / 'icon' / 'app-store-1024.png')

for src_name, dst_name in [
    ('icon-16.png', 'favicon-16x16.png'),
    ('icon-32.png', 'favicon-32x32.png'),
    ('icon-48.png', 'favicon-48x48.png'),
    ('icon-180.png', 'apple-touch-icon.png'),
    ('icon-192.png', 'android-chrome-192x192.png'),
    ('icon-512.png', 'android-chrome-512x512.png'),
]:
    Image.open(OUT / 'icon' / src_name).save(OUT / 'web' / dst_name)

print(f'Generated assets from {SRC} into {OUT}')
