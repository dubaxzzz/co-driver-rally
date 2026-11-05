"""
Two-browser end-to-end test: a driver and a navigator in separate browser
contexts (separate sessions), connected through the real server.

Requires: pip install playwright && playwright install chromium
Run with `npm run dev` already running, then: npm run test:e2e
"""
import os
import asyncio
from playwright.async_api import async_playwright
BASE = os.environ.get('BASE_URL', 'http://localhost:5173')

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'])
        d = await b.new_context(viewport={'width':1280,'height':720})
        n = await b.new_context(viewport={'width':1024,'height':768})
        dp = await d.new_page(); np_ = await n.new_page()
        errs=[]
        for pg,tag in ((dp,'driver'),(np_,'nav')):
            pg.on('console', lambda m, t=tag: errs.append(f'{t} console.{m.type}: {m.text}') if m.type in ('error','warning') else None)
            pg.on('pageerror', lambda e, t=tag: errs.append(f'{t} PAGEERROR: {e}'))
        os.makedirs('tests/artifacts', exist_ok=True)
        await dp.goto(BASE+'/#/create'); 
        await dp.wait_for_function("/^[A-Z0-9]{4}$/.test(document.querySelector('[data-testid=room-code]')?.textContent||'')", timeout=15000)
        code = (await dp.text_content('[data-testid=room-code]')).strip()
        print('code', code)
        await np_.goto(BASE+'/#/join/'+code)
        await np_.click('[data-testid=join-btn]')
        await np_.wait_for_selector('.nav', timeout=10000)
        await dp.wait_for_function("document.querySelector('[data-testid=navigator-state]')?.textContent==='Connected'", timeout=10000)
        print('both connected')
        await dp.click('[data-testid=start-stage]')
        await dp.wait_for_selector('canvas.webgl', timeout=60000)
        await asyncio.sleep(8)
        await dp.keyboard.down('KeyW')
        await asyncio.sleep(6)
        await dp.keyboard.up('KeyW')
        await np_.click('[data-testid=send-next]')
        await asyncio.sleep(1)
        print('driver call shown:', await dp.text_content('.hud-call .msg'))
        print('nav speed:', await np_.text_content('.nav-data .v'), 'progress', await np_.evaluate("document.querySelectorAll('.nav-data .v')[3].textContent"))
        print('nav map status:', await np_.text_content('.map-status'))
        print('driver HUD speed', await dp.text_content('.hud-speed'), 'timer', await dp.text_content('.hud-timer .t'))
        await dp.screenshot(path='tests/artifacts/driver.png'); await np_.screenshot(path='tests/artifacts/nav.png')
        print('\n'.join(errs[:20]) or 'no console errors')
        await b.close()
asyncio.run(main())
