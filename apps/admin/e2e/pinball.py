"""Flipper: skapa turnering, spelare, maskiner, matchplay-steg, spelplansmatris, resultat, omgång 2 och publik live-vy (browser)."""
import json,random,sys,subprocess,urllib.request
from playwright.sync_api import sync_playwright
FAIL=[]
def check(c,m):
    print(("OK   " if c else "FEL  ")+m)
    if not c: FAIL.append(m)
tag=str(random.randint(10000,99999)); email=f"pin{tag}@example.test"; wsname=f"Pin-E2E {tag}"; slug=f"pin-{tag}"
req=urllib.request.Request("http://127.0.0.1:4000/api/v1/auth/register",method="POST",headers={"content-type":"application/json","x-requested-with":"platform-customer"},
    data=json.dumps({"email":email,"password":"Kundlösenord-2026","name":"Kund Pin","workspaceName":wsname,"products":["association_portal","tournament_system"],"acceptTerms":True}).encode())
urllib.request.urlopen(req).read()
wid=subprocess.run(["psql","postgres://plattform:plattform_dev@localhost:5432/plattform_dev","-tAc",f"select id from workspaces where name='{wsname}'"],capture_output=True,text=True).stdout.strip()
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1400,"height":1000}); pg.goto("http://127.0.0.1:5176/")
    pg.fill("input[type=email]",email); pg.fill("input[type=password]","Kundlösenord-2026"); pg.click("button:has-text('Logga in')"); pg.wait_for_selector("h1:has-text('Turneringar')")
    pg.click("button:has-text('Ny turnering')"); pg.fill("div.modal input >> nth=0","Flipper-SM"); pg.select_option("select[aria-label=Format]","pinball"); pg.click("div.modal button:has-text('Skapa')")
    pg.wait_for_selector("h1:has-text('Flipper-SM')"); check(pg.locator(".badge:has-text('Utkast')").count()==1,"flipperturnering skapad som utkast")
    pg.fill("textarea[aria-label='Spelare att lägga till']","\n".join(f"Spelare {i}" for i in range(1,9))); pg.click("section:has(h2:has-text('Spelare')) button:has-text('Lägg till')"); pg.wait_for_selector("ol[aria-label=Spelare] li >> nth=7")
    check(pg.locator("ol[aria-label=Spelare] li").count()==8,"åtta spelare tillagda")
    pg.fill("textarea[aria-label='Maskiner att lägga till']","Medieval Madness\nAttack from Mars\nTwilight Zone\nTerminator 2"); pg.click("section:has(h2:has-text('Maskiner')) button:has-text('Lägg till')"); pg.wait_for_selector("ul[aria-label=Maskiner] li >> nth=3")
    pg.fill("textarea[aria-label='Spelare att lägga till']","spelare 1"); pg.click("section:has(h2:has-text('Spelare')) button:has-text('Lägg till')"); pg.wait_for_selector("text=Finns redan"); check(pg.locator("ol[aria-label=Spelare] li").count()==8,"dubblettspelare nekas")
    pg.select_option("select[aria-label='Typ av steg']","matchplay"); pg.fill("input[aria-label=Omgångar]","2"); pg.click("button:has-text('Lägg till steg')"); pg.wait_for_selector("ol[aria-label=Steg] li")
    pg.click("ol[aria-label=Steg] button:has-text('Starta')"); pg.wait_for_selector("table[aria-label='Spelplan']")
    check(pg.locator("table[aria-label='Spelplan'] thead th").count()==6,"matrisen har kolumn per maskin + ej tilldelad")
    check(pg.locator("table[aria-label='Spelplan'] tbody th:has-text('Omgång 1')").count()==1,"en rad för omgång 1")
    cells=pg.locator("table[aria-label='Spelplan'] button.pcell"); check(cells.count()==2,"två bord (8 spelare i grupper om 4)")
    check(pg.locator(".badge:has-text('Pågår')").count()>=1,"turneringen pågår")
    # starta spel på första bordet → maskinen visas som upptagen
    cells.nth(0).click(); pg.wait_for_selector("div.modal"); pg.click("div.modal button:has-text('Starta spel')"); pg.wait_for_selector(".pmachine.busy"); check(pg.locator(".pmachine.busy").count()==1,"maskinöversikten visar en upptagen maskin")
    check(pg.locator(".pcell.playing").count()==1,"matrisen markerar pågående spel")
    for i in range(2):
        pg.locator("table[aria-label='Spelplan'] button.pcell").nth(i).click(); pg.wait_for_selector("div.modal")
        for k,inp in enumerate(pg.locator("div.modal input[type=number]").all()): inp.fill(str((4-k)*1000000))
        pg.click("div.modal button:has-text('Spara resultat')"); pg.wait_for_selector("div.modal",state="detached")
    pg.wait_for_function("document.querySelectorAll('.pcell.done').length===2"); check(pg.locator(".pcell.done").count()==2,"båda borden klara")
    check("7p" in pg.inner_text("table[aria-label='Spelplan']") and "1p" in pg.inner_text("table[aria-label='Spelplan']"),"placeringspoäng 7-5-3-1 visas i matrisen")
    check(pg.locator(".pmachine.busy").count()==0,"inga upptagna maskiner efter resultat")
    pg.wait_for_selector("table[aria-label='Ställning'] tbody tr"); check(pg.locator("table[aria-label='Ställning'] tbody tr").count()==8,"ställning med åtta spelare")
    pg.fill("textarea[aria-label='Spelare att lägga till']","Sen Spelare"); pg.click("section:has(h2:has-text('Spelare')) button:has-text('Lägg till')"); pg.wait_for_selector("ol[aria-label=Spelare] li >> nth=8"); check(pg.locator("ol[aria-label=Spelare] li").count()==9,"sen anmälan efter start lägger till spelare nummer nio")
    pg.click("button:has-text('Skapa omgång 2')"); pg.wait_for_selector("table[aria-label='Spelplan'] tbody th:has-text('Omgång 2')"); check(pg.locator("table[aria-label='Spelplan'] tbody tr").count()==2,"omgång 2 skapad"); check(pg.locator("table[aria-label='Spelplan'] tbody tr:has(th:has-text('Omgång 2')) .pcell").count()==3,"omgång 2 har tre bord om tre (9 spelare) inklusive sena spelaren")
    pg.screenshot(path="/tmp/shots/5_flipper_matris.png")
    # publik live-vy
    H={"x-requested-with":"platform-customer","content-type":"application/json"}
    def api(m,path,body=None): r=pg.request.fetch(f"http://127.0.0.1:5176/api/v1{path}",method=m,headers=H,data=json.dumps(body) if body is not None else None); return r.status
    check(api("PUT",f"/workspaces/{wid}/public-page",{"enabled":True,"slug":slug,"showNews":True,"consent":True})==200,"publik sida påslagen")
    tid=pg.url.rstrip("/").split("/")[-1]
    pg.click("label:has-text('Visa publikt') input"); pg.wait_for_function("document.querySelector('label input[type=checkbox]').checked"); check(True,"turneringen publicerad via kryssrutan")
    a=b.new_context(viewport={"width":1400,"height":900}).new_page(); a.goto(f"http://127.0.0.1:5175/p/{slug}/t/{tid}"); a.wait_for_selector("table[aria-label='Spelplan']")
    check(a.locator("table[aria-label='Spelplan'] button").count()==0,"publik vy är skrivskyddad (inga knappar i matrisen)")
    check("spelare 1" in a.inner_text("body").lower() and "omgång 2" in a.inner_text("body").lower(),"publik vy visar spelare och omgång 2")
    check("uppdateras automatiskt" in a.inner_text("body"),"publik vy anger live-uppdatering")
    a.screenshot(path="/tmp/shots/6_flipper_publik.png")
sys.exit(1 if FAIL else 0)
