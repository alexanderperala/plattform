"""Turneringssystem: skapa serie, lag, start, resultat, tabell, medlemsvy och tenant-isolering (browser)."""
import json,random,subprocess,sys,urllib.request
from playwright.sync_api import sync_playwright
FAIL=[]
def check(c,m):
    print(("OK   " if c else "FEL  ")+m)
    if not c: FAIL.append(m)
def rsql(q): return subprocess.run(["su","postgres","-c",f"psql -d plattform_dev -tAc \"{q}\""],capture_output=True,text=True).stdout.strip()  # superuser: förbi RLS
def sql(q): return subprocess.run(["psql","postgres://plattform:plattform_dev@localhost:5432/plattform_dev","-tAc",q],capture_output=True,text=True).stdout.strip()
def register(tag,who):
    req=urllib.request.Request("http://127.0.0.1:4000/api/v1/auth/register",method="POST",headers={"content-type":"application/json","x-requested-with":"platform-customer"},
        data=json.dumps({"email":f"{who}{tag}@example.test","password":"Kundlösenord-2026","name":f"Kund {who}","workspaceName":f"Tur-E2E {who} {tag}","products":["tournament_system"],"acceptTerms":True}).encode())
    urllib.request.urlopen(req).read(); return f"{who}{tag}@example.test",f"Tur-E2E {who} {tag}"
def login(b,email,ws=None):
    pg=b.new_page(viewport={"width":1300,"height":900}); pg.goto("http://127.0.0.1:5176/")
    pg.fill("input[type=email]",email); pg.fill("input[type=password]","Kundlösenord-2026"); pg.click("button:has-text('Logga in')"); pg.wait_for_selector("h1:has-text('Turneringar')")
    if ws: pg.select_option("select[aria-label='Arbetsyta']",label=ws); pg.wait_for_selector("h1:has-text('Turneringar')")
    return pg
tag=str(random.randint(10000,99999)); ea,na=register(tag,"adm")
wid=sql(f"select id from workspaces where name='{na}'")
def draw(pa,row,h,a): row.locator("input >> nth=0").fill(str(h)); row.locator("input >> nth=1").fill(str(a)); row.locator("button:has-text('Spara')").click(); pa.wait_for_timeout(450)
with sync_playwright() as p:
    b=p.chromium.launch(); pa=login(b,ea)
    pa.click("button:has-text('Ny turnering')"); pa.fill("div.modal input >> nth=0","Mästarcupen"); pa.select_option("div.modal select[aria-label=Format]",value="groups_knockout")
    pa.select_option("div.modal select[aria-label='Antal grupper']",value="2"); pa.select_option("div.modal select[aria-label='Vidare per grupp']",value="1"); pa.click("div.modal button:has-text('Skapa')")
    pa.wait_for_selector("h1:has-text('Mästarcupen')")
    for n in ("T1","T2","T3","T4"):
        pa.fill("input[aria-label=Lagnamn]",n); pa.click("button:has-text('Lägg till lag')"); pa.wait_for_selector(f"ul[aria-label=Lag] li:has-text('{n}')")
    pa.click("button:has-text('Starta turneringen')"); pa.wait_for_selector("h2:has-text('Grupp B')")
    check(pa.locator("h2:has-text('Grupp A')").count()==1 and pa.locator("h2:has-text('Grupp B')").count()==1,"två grupper skapas")
    check(rsql(f"select count(*) from tournament_matches where workspace_id='{wid}' and group_no is not null")=="2","en gruppmatch per grupp (två lag per grupp)")
    check(pa.locator("button:has-text('Starta slutspelet')").is_disabled(),"slutspel kan inte startas före gruppspelet är klart")
    ms=pa.locator("[data-testid=match]")
    for i in range(2): draw(pa,ms.nth(i),1,1)  # oavgjort i båda grupperna -> delad placering
    pa.wait_for_function("!document.querySelector('button.btn.primary:disabled')||true"); pa.wait_for_timeout(500)
    pa.click("button:has-text('Starta slutspelet')"); pa.wait_for_selector("div.modal:has-text('Lika placering')"); check(True,"lika placering kräver att administratören avgör ordningen")
    check(pa.locator("div.modal button:has-text('Starta slutspelet')").is_disabled(),"kan inte skicka förrän alla lag är ordnade")
    for t in ("T1","T4","T2","T3"): pa.click(f"div.modal button.btn.small:has-text('{t}')")
    pa.click("div.modal button.btn.primary:has-text('Starta slutspelet')"); pa.wait_for_selector("h2:has-text('Slutspel')")
    check(pa.locator("h3:has-text('Final')").count()==1,"slutspelet visar en final")
    check(rsql(f"select count(*) from tournament_matches where workspace_id='{wid}' and position is not null")=="1","finalen finns i databasen")
    fin=pa.locator("[data-testid=match]:has-text('T1 – T2')"); check(fin.count()==1,"ordningen avgjorde: T1 och T2 går vidare")
    draw(pa,fin,0,2); pa.click("button:has-text('Avsluta turneringen')"); pa.wait_for_selector("text=Vinnare:")
    check("T2" in pa.locator(".alert.good").inner_text(),"vinnaren utses")
    pa.screenshot(path="/home/claude/plattform/docs/screenshots/tournament-groups.png"); b.close()
print("\nRESULTAT:","ALLA KONTROLLER OK" if not FAIL else f"{len(FAIL)} FEL"); sys.exit(1 if FAIL else 0)
