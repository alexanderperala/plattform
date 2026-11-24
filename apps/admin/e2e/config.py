import hmac,hashlib,base64,struct,time
from playwright.sync_api import sync_playwright
def totp(s,off=0):
    k=base64.b32decode(s); c=int(time.time())//30+off
    h=hmac.new(k,struct.pack(">Q",c),hashlib.sha1).digest(); o=h[-1]&15
    return "%06d"%((struct.unpack(">I",h[o:o+4])[0]&0x7fffffff)%1000000)
SH="/home/claude/plattform/docs/screenshots/"; SEC="JBSWY3DPEHPK3PXP"
def login(b,email):
    pg=b.new_page(viewport={"width":1300,"height":900}); pg.goto("http://127.0.0.1:5173/")
    pg.fill('input[type=email]',email); pg.fill('input[type=password]',"DevAdminPassword!2026"); pg.click("text=Fortsätt")
    pg.wait_for_selector("text=Tvåstegsverifiering"); pg.fill("input",totp(SEC)); pg.click("button:has-text('Verifiera')"); pg.wait_for_selector("h1:has-text('Översikt')"); return pg
def reauth(pg,btn):
    try: pg.wait_for_selector("div.modal input[autocomplete=one-time-code]",timeout=2500)
    except Exception: return
    pg.fill("div.modal input[autocomplete=one-time-code]",totp(SEC,1)); pg.click(f"div.modal button:has-text('{btn}')")
with sync_playwright() as p:
    b=p.chromium.launch()
    pg=login(b,"super@example.test")
    pg.click("nav a[href='/flags']"); pg.wait_for_selector("h2:has-text('association.forum_v2')")
    card=pg.locator("div.card:has(h2:has-text('association.forum_v2'))")
    card.locator("button:has-text('Slå på som standard')").click(); pg.fill("div.modal textarea","Aktiverar forumbeta för alla kunder enligt beslut"); pg.click("div.modal button:has-text('Ändra standard')"); reauth(pg,'Ändra standard')
    card.locator("button:has-text('Stäng av som standard')").wait_for(timeout=6000); print("standard ändrad till På")
    card.locator("button:has-text('Lägg till överstyrning')").click(); pg.fill("div.modal input[type=search]","a")
    pg.fill("div.modal input[type=search]","Förening"); pg.wait_for_function("document.querySelectorAll('div.modal select option').length>2",timeout=6000)
    pg.select_option("div.modal select >> nth=0",index=1); pg.select_option("div.modal select >> nth=1","off")
    pg.fill("div.modal textarea","Kunden vill vänta med forumet"); pg.click("div.modal button:has-text('Spara överstyrning')"); reauth(pg,'Spara överstyrning')
    pg.wait_for_selector("div.card:has(h2:has-text('association.forum_v2')) table",timeout=6000); print("överstyrning skapad")
    pg.screenshot(path=SH+"admin-flags.png",full_page=True)
    card.locator("button:has-text('Slå på')").count()
    card.locator("tr:has-text('Av') button:has-text('Ta bort')").click(); pg.fill("div.modal textarea","Återgår till standardvärdet för alla"); pg.click("div.modal button:has-text('Ta bort')"); reauth(pg,'Ta bort')
    pg.wait_for_function("document.querySelectorAll('tr').length>0 && ![...document.querySelectorAll('tr')].some(r=>r.innerText.includes('Förening') && r.innerText.includes('Av'))"); print("överstyrning borttagen")
    card.locator("button:has-text('Stäng av som standard')").click(); pg.fill("div.modal textarea","Återställer standardvärdet efter test av flaggan"); pg.click("div.modal button:has-text('Ändra standard')"); reauth(pg,'Ändra standard')
    card.locator("button:has-text('Slå på som standard')").wait_for(timeout=6000)
    pg.click("nav a[href='/settings']"); pg.wait_for_selector("text=Respitperiod vid förfallen betalning")
    row=pg.locator("tr:has-text('billing.grace_period_days')"); row.locator("button:has-text('Ändra')").click()
    pg.fill("div.modal input[type=number]","999"); pg.fill("div.modal textarea","Testar att för högt värde stoppas i formuläret"); pg.click("div.modal button:has-text('Spara')"); pg.wait_for_timeout(800)
    print("för högt värde stoppas i formuläret:", pg.locator("div.modal").count()==1)
    pg.fill("div.modal input[type=number]","14"); pg.click("div.modal button:has-text('Spara')"); reauth(pg,'Spara')
    pg.wait_for_selector("div.modal",state="detached",timeout=6000); pg.wait_for_selector("tr:has-text('billing.grace_period_days') >> text=Super")
    pg.screenshot(path=SH+"admin-settings.png",full_page=True); print("inställning sparad med ändrad-av")
    pt=login(b,"tech@example.test"); print("tekniker ser Flaggor:",pt.locator("nav a[href='/flags']").count()," Inställningar:",pt.locator("nav a[href='/settings']").count())
    pt.click("nav a[href='/flags']"); pt.wait_for_selector("h2:has-text('association.forum_v2')"); print("tekniker kan ändra flagga:",pt.locator("button:has-text('Stäng av som standard'), button:has-text('Slå på som standard')").count()>0)
    pr=login(b,"readonly@example.test"); pr.click("nav a[href='/flags']"); pr.wait_for_selector("text=Din roll kan se flaggorna"); print("read-only: ingen ändringsknapp:",pr.locator("button:has-text('Slå på som standard'), button:has-text('Stäng av som standard')").count()==0)
    b.close()
