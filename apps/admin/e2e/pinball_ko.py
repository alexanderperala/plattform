"""Flipper: gruppslutspel (4 spelare, två vidare) och enkel utslagning med bronsmatch i webbläsaren."""
import json,random,sys,subprocess,urllib.request
from playwright.sync_api import sync_playwright
FAIL=[]
def check(c,m):
    print(("OK   " if c else "FEL  ")+m)
    if not c: FAIL.append(m)
tag=str(random.randint(10000,99999)); email=f"pko{tag}@example.test"; wsname=f"PinKO-E2E {tag}"
urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:4000/api/v1/auth/register",method="POST",headers={"content-type":"application/json","x-requested-with":"platform-customer"},
    data=json.dumps({"email":email,"password":"Kundlösenord-2026","name":"Kund KO","workspaceName":wsname,"products":["tournament_system"],"acceptTerms":True}).encode())).read()
def create(pg,name,stage_kind,setup):
    pg.goto("http://127.0.0.1:5176/tournaments"); pg.wait_for_selector("h1:has-text('Turneringar')"); pg.click("button:has-text('Ny turnering')"); pg.fill("div.modal input >> nth=0",name); pg.select_option("select[aria-label=Format]","pinball"); pg.click("div.modal button:has-text('Skapa')"); pg.wait_for_selector(f"h1:has-text('{name}')")
    pg.fill("textarea[aria-label='Spelare att lägga till']","\n".join(f"Spelare {i}" for i in range(1,9))); pg.click("section:has(h2:has-text('Spelare')) button:has-text('Lägg till')"); pg.wait_for_selector("ol[aria-label=Spelare] li >> nth=7")
    pg.fill("textarea[aria-label='Maskiner att lägga till']","Maskin A\nMaskin B\nMaskin C"); pg.click("section:has(h2:has-text('Maskiner')) button:has-text('Lägg till')"); pg.wait_for_selector("ul[aria-label=Maskiner] li >> nth=2")
    pg.select_option("select[aria-label='Typ av steg']",stage_kind); setup(pg); pg.click("button:has-text('Lägg till steg')"); pg.wait_for_selector("ol[aria-label=Steg] li"); pg.click("ol[aria-label=Steg] button:has-text('Starta')"); pg.wait_for_selector("table[aria-label='Spelplan']")
def enter(pg,cell):
    before=pg.locator("table[aria-label='Spelplan'] .pcell.done").count(); cell.click(); pg.wait_for_selector("div.modal")
    for k,inp in enumerate(pg.locator("div.modal input[type=number]").all()): inp.fill(str((9-k)*1000))
    pg.click("div.modal button:has-text('Spara resultat')"); pg.wait_for_selector("div.modal",state="detached")
    pg.wait_for_function("n => document.querySelectorAll(\"table[aria-label='Spelplan'] .pcell.done\").length > n", arg=before)  # vänta tills resultatet syns i matrisen
def play_all(pg):
    for _ in range(40):
        c=pg.locator("table[aria-label='Spelplan'] button.pcell:not(.done)")
        if c.count()==0: return
        enter(pg,c.first)
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1400,"height":1000}); pg.goto("http://127.0.0.1:5176/")
    pg.fill("input[type=email]",email); pg.fill("input[type=password]","Kundlösenord-2026"); pg.click("button:has-text('Logga in')"); pg.wait_for_selector("h1:has-text('Turneringar')")
    def gk(pg): pg.select_option("select[aria-label='Spel per grupp']","1")
    create(pg,"Gruppslutspel","group_knockout",gk)
    check(pg.locator("table[aria-label='Spelplan'] button.pcell").count()==2,"åtta spelare ger två grupper om fyra")
    play_all(pg); pg.wait_for_selector("table[aria-label^='Grupp 1.']"); check(pg.locator("table[aria-label^='Grupp 1.'] tr.advances").count()==4,"två per grupp markeras som vidare (fyra totalt)")
    pg.click("button:has-text('Skapa omgång 2')"); pg.wait_for_selector("table[aria-label='Spelplan'] tbody th:has-text('Omgång 2')"); check(pg.locator("table[aria-label='Spelplan'] tbody tr:has(th:has-text('Omgång 2')) .pcell").count()==1,"omgång 2 är en finalgrupp med fyra spelare")
    check(pg.locator("button:has-text('Skapa omgång 3')").count()==0,"ingen ytterligare omgång efter finalgruppen")
    play_all(pg); pg.wait_for_selector("ol[aria-label=Slutplacering] li"); check(pg.locator("ol[aria-label=Slutplacering] li").count()==8,"slutplacering för alla åtta")
    pg.click("ol[aria-label=Steg] button:has-text('Avsluta steget')"); pg.wait_for_selector("ol[aria-label=Steg] .badge:has-text('Klart')"); check(True,"steget avslutat")
    pg.click("button:has-text('Avsluta turneringen')"); pg.wait_for_selector(".badge:has-text('Avslutad')"); check(True,"turneringen avslutad")
    def ko(pg): pg.select_option("select[aria-label='Typ av steg']","single_elim"); pg.check("label:has-text('Bronsmatch') input")
    create(pg,"Cup med bronsmatch","single_elim",ko)
    play_all(pg) if False else None
    for _ in range(30):
        c=pg.locator("table[aria-label='Spelplan'] button.pcell:not(.done)")
        if c.count()==0: break
        enter(pg,c.first)
    check(pg.locator("table[aria-label='Spelplan'] .pcell:has-text('Bronsmatch')").count()==1,"bronsmatch finns i matrisen")
    pg.wait_for_selector("table[aria-label='Ställning'] tbody tr"); check(pg.locator("table[aria-label='Ställning'] tbody tr").count()==8,"slutplacering för alla åtta spelare med bronsmatch")
    pg.click("ol[aria-label=Steg] button:has-text('Avsluta steget')"); pg.wait_for_selector("ol[aria-label=Steg] .badge:has-text('Klart')"); check(True,"cupen avslutad efter bronsmatch")
sys.exit(1 if FAIL else 0)
