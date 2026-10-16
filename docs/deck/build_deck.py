"""Build the BCH BLAZE presentation PDF from docs/deck/deck.html (headless Chromium via Playwright).

usage: python docs/deck/build_deck.py [preview_dir]
  -> docs/AgentLeash_BLAZE2026.pdf (16:9, 1280x720 px pages)
  -> preview_dir/slide-NN.png (optional, needs pypdfium2) to check every page by eye
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / 'AgentLeash_BLAZE2026.pdf'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    page.goto((HERE / 'deck.html').as_uri())
    page.wait_for_load_state('networkidle')
    broken = page.evaluate("[...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => i.src)")
    if broken:
        raise SystemExit(f'images failed to load: {broken}')
    tall = page.evaluate("[...document.querySelectorAll('section')].map((s, i) => [i + 1, s.scrollHeight, s.scrollWidth]).filter(([, h, w]) => h > 720 || w > 1280)")
    if tall:
        raise SystemExit(f'slides overflow 1280x720 (slide, height, width): {tall}')
    page.pdf(path=str(OUT), width='1280px', height='720px', print_background=True, margin={'top': '0', 'right': '0', 'bottom': '0', 'left': '0'})
    browser.close()
print('wrote', OUT, OUT.stat().st_size, 'bytes')

if len(sys.argv) > 1:
    import pypdfium2 as pdfium
    d = pathlib.Path(sys.argv[1])
    d.mkdir(parents=True, exist_ok=True)
    pdf = pdfium.PdfDocument(str(OUT))
    for i in range(len(pdf)):
        pdf[i].render(scale=1).to_pil().save(d / f'slide-{i + 1:02d}.png')
    print('pages', len(pdf), '->', d)
